// get magnetic declination for a given location
// (uses NOAA NCEI api)
function getDeclination(lon: number, lat: number, callback: (decl: number) => void) {
  fetch(`https://www.ngdc.noaa.gov/geomag-web/calculators/calculateDeclination?lat1=${lat}&lon1=${lon}&resultFormat=json`).then(res => res.json()).then(data => callback(data.result[0].declination));
}

const SCROLL_LOAD_DELAY = 350;

interface MapLayer {
  url: string;
  opacity: number;
  tileSize: number;
}

type MapLayerTiles = MapLayer & {
  tiles: TileSetBuffer;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

const MARGINS: [[number, number], [number, number]] = [[40, 40], [30, 80]];

class MapApp {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  
  view: Viewport;
  declination: number;
  declinationGetCallbackId: number;
  
  // maps to display
  layers: MapLayerTiles[];

  // should the longitude / latitude marks + scale be displayed
  showDecorators: boolean;

  // main boundary/margin size (pixels)
  margin: [[number, number], [number, number]];

  // mouse movements
  pMouseX: number;
  pMouseY: number;
  mouseClicked: boolean;

  // scroll throttling
  wheelCallbackId: number | null;

  callbackId: number | null;

  constructor(id: string, layers: MapLayer[], showDecorators: boolean) {
    this.canvas = document.getElementById(id) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d');
    this.width = this.canvas.width;
    this.height = this.canvas.height;

    this.mouseClicked = false;
    this.callbackId = null;
    this.wheelCallbackId = null;
    this.canvas.addEventListener('mousedown', function(e: MouseEvent) { this.mousedown(e); }.bind(this));
    this.canvas.addEventListener('mouseup', function(e: MouseEvent) { this.mouseup(e); }.bind(this));
    this.canvas.addEventListener('mouseleave', function(e: MouseEvent) { this.mouseup(e); }.bind(this));
    this.canvas.addEventListener('mousemove', function(e: MouseEvent) { this.mousemove(e); }.bind(this));
    this.canvas.addEventListener('wheel', function(e: WheelEvent) { this.wheel(e); }.bind(this));

    this.margin = showDecorators ? MARGINS : [[0, 0], [0, 0]];
    this.showDecorators = showDecorators;

    this.view = new Viewport(0.0, 0.0, 1.0, 1.0);
    this.declination = 0.0;
    this.declinationGetCallbackId = null;
    this.setLayers(layers);
  }

  setLayers(layers: MapLayer[]) {
    this.layers = layers.map((layer) => {
      const canvas = document.createElement("canvas");
      canvas.width = this.viewSize()[0];
      canvas.height = this.viewSize()[1];
      return {
        ...layer,
        canvas,
        ctx: canvas.getContext("2d"),
        tiles: new TileSetBuffer(
          layer.url, 
          function() {
            if(this.callbackId == null) { 
              this.callbackId = window.requestAnimationFrame(function() { this.run(); }.bind(this));
            }
          }.bind(this)
        )
      };
    });

    this.loadTiles();
  }

  mousedown(e: MouseEvent) {
    this.mouseClicked = true;
    this.pMouseX = e.offsetX;
    this.pMouseY = e.offsetY;
  }

  mouseup(e: MouseEvent) {
    this.mouseClicked = false;
  }

  private mousePos(x: number, y: number): [number, number] {
    return [
      (x - this.margin[0][0]) / (this.width - this.margin[0][0] - this.margin[0][1]),
      (y - this.margin[1][0]) / (this.height - this.margin[1][0] - this.margin[1][1]),
    ];
  }

  private viewSize(): [number, number] {
    return [
      (this.width - this.margin[0][0] - this.margin[0][1]),
      (this.height - this.margin[1][0] - this.margin[1][1])
    ];
  }

  mousemove(e: MouseEvent) {
    if(!this.mouseClicked) {
      return;
    }

    const [w, h] = this.viewSize();
    this.view.pan(-(e.offsetX - this.pMouseX) / w, -(e.offsetY - this.pMouseY) / h);
    this.loadTiles();
    this.run();
    this.pMouseX = e.offsetX;
    this.pMouseY = e.offsetY;
  }

  wheel(e: WheelEvent) {
    const [x, y] = this.mousePos(e.offsetX, e.offsetY);
    this.view.zoom(e.deltaY * 0.005, x, y);

    // set tile loading to occur SCROLL_LOAD_DELAY after scrolling stops
    if(this.wheelCallbackId != null) {
      window.clearTimeout(this.wheelCallbackId);
    }
    this.wheelCallbackId = window.setTimeout(function() { this.loadTiles(); }.bind(this), SCROLL_LOAD_DELAY);

    this.run();
  }

  private loadTiles() {
    for(let l = 0; l < this.layers.length; l++) {
      const zoom = this.view.tileZoomLevel(this.viewSize()[0], this.viewSize()[1], this.layers[l].tileSize);
      this.layers[l].tiles.loadNew(this.view, zoom);
    }
    if(this.declinationGetCallbackId !== null) {
      window.clearTimeout(this.declinationGetCallbackId);
    }
    this.declinationGetCallbackId = window.setTimeout(() => {
      getDeclination(this.view.centerLonLat()[0], this.view.centerLonLat()[1], (decl) => {
        this.declination = decl;
        this.run();
      })
    }, SCROLL_LOAD_DELAY);
  }

  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.view.matchAspect(this.width, this.height);
    for(let l = 0; l < this.layers.length; l++) {
      this.layers[l].canvas.width = this.viewSize()[0];
      this.layers[l].canvas.height = this.viewSize()[1];
    }

    this.loadTiles();
    this.run();
  }

  setShowDecorators(showDecorators: boolean) {
    this.showDecorators = showDecorators;
    this.margin = showDecorators ? MARGINS : [[0, 0], [0, 0]];
    this.resize(this.width, this.height);
  }

  // pick longitude and latitude line distance (in degrees)
  private lonLatInterval(sizePixels: number, degreeRange: number): number {
    const maxNum = Math.floor(sizePixels / 140.0);
    const dist = degreeRange / maxNum;
    const [d, m, s] = decimalToDMS(dist);
    return DMSToDecimal(Math.round(d), Math.round(m), Math.round(s));
  }

  // return degree values to draw longitude/latitude indicators at
  private lonLatIndicatorLocs(sizePixels: number, lowDegrees: number, highDegrees: number): number[] {

    const interval = this.lonLatInterval(sizePixels, Math.abs(highDegrees - lowDegrees));
    let res = [];

    const start = lowDegrees + interval - mod(lowDegrees, interval);
    const end = highDegrees - highDegrees % interval;

    for(let i = start; i <= end; i += interval) {
      res.push(i);
    }

    return res;
  }

  private xTileToCanvasPos(x: number): number {
    const normal = (x - this.view.x0) / (this.view.x1 - this.view.x0);
    return Math.floor(this.margin[0][0] + normal * this.viewSize()[0]);
  }

  private yTileToCanvasPos(y: number): number {
    const normal = (y - this.view.y0) / (this.view.y1 - this.view.y0);
    return Math.floor(this.margin[1][0] + normal * this.viewSize()[1]);
  }

  // draw longitude and latitude indicators
  private drawLonLatLines() {
    const [sx, sy] = this.viewSize();
    // draw border
    let thickness = 0.5;
    this.ctx.strokeStyle = "#000000";
    this.ctx.lineWidth = 2 * thickness;
    this.ctx.strokeRect(this.margin[0][0] - thickness, this.margin[1][0] - thickness, sx + 2 * thickness, sy + 2 * thickness);
    // get longitude / latitudes to draw
    const [lon0, lat0] = new TileCoordinate(0, this.view.x0, this.view.y1).toLonLat();
    const [lon1, lat1] = new TileCoordinate(0, this.view.x1, this.view.y0).toLonLat();
    const lonIndicators = this.lonLatIndicatorLocs(sx, lon0, lon1);
    const latIndicators = this.lonLatIndicatorLocs(sy, lat0, lat1);

    let lineLen = 20;
    let lineOverhang = 5;
    thickness = 1;
    this.ctx.lineWidth = 2 * thickness;
    this.ctx.font = "14px sans-serif";
    this.ctx.fillStyle = "#000000";

    // draw longitude marks
    for(let i = 0; i < lonIndicators.length; i++) {
      const lon = lonIndicators[i];
      let x = TileCoordinate.fromLonLat(lon, 0.0).atZoom(0)[0];
      x = this.xTileToCanvasPos(x);
      if(x - this.margin[0][0] < lineLen || this.margin[0][0] + this.viewSize()[0] - x < lineLen) {
        continue;
      }

      this.ctx.beginPath();
      this.ctx.moveTo(x - thickness, this.margin[1][0] - lineOverhang);
      this.ctx.lineTo(x - thickness, this.margin[1][0] + lineLen);
      this.ctx.stroke();

      this.ctx.beginPath();
      this.ctx.moveTo(x - thickness, this.margin[1][0] + this.viewSize()[1] + lineOverhang);
      this.ctx.lineTo(x - thickness, this.margin[1][0] + this.viewSize()[1] - lineLen);
      this.ctx.stroke();

      // write out coordinates
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "bottom";
      this.ctx.fillText(formatDegrees(lon), x, this.margin[1][0] - lineOverhang);
      this.ctx.textBaseline = "top";
      this.ctx.fillText(formatDegrees(lon), x, this.margin[1][0] + this.viewSize()[1] + lineOverhang + 2);
    }

    // draw latitude marks
    for(let i = 0; i < latIndicators.length; i++) {
      const lat = latIndicators[i];
      let y = TileCoordinate.fromLonLat(0.0, lat).atZoom(0)[1];
      y = this.yTileToCanvasPos(y);
      if(y - this.margin[1][0] < lineLen || this.margin[1][0] + this.viewSize()[1] - y < lineLen) {
        continue;
      }

      this.ctx.beginPath();
      this.ctx.moveTo(this.margin[0][0] - lineOverhang, y - thickness);
      this.ctx.lineTo(this.margin[0][0] + lineLen, y - thickness);
      this.ctx.stroke();

      this.ctx.beginPath();
      this.ctx.moveTo(this.margin[0][0] + this.viewSize()[0] + lineOverhang, y - thickness);
      this.ctx.lineTo(this.margin[0][0] + this.viewSize()[0] - lineLen, y - thickness);
      this.ctx.stroke();

      // write out coordinates
      let writeLines = (lines: string[], x: number, y: number) => {
        let interval = 17;
        let offset = -(lines.length / 2) + 0.5;
        for(let i = 0; i < lines.length; i++) {
          this.ctx.fillText(lines[i], x, y + (i + offset) * interval);
        }
      };
      this.ctx.textBaseline = "middle";
      this.ctx.textAlign = "right";
      writeLines(formatDegreesComponents(lat), this.margin[0][0] - lineOverhang, y);
      this.ctx.textAlign = "left";
      writeLines(formatDegreesComponents(lat), this.margin[0][0] + this.viewSize()[0] + lineOverhang + 2, y);
    }
  }

  private drawScale(offX: number, offY: number, width: number, widthSize: number, unit: string, firstIntervalDivisions: number) {
    let numIntervals = Math.floor(width / 120.0);
    numIntervals = numIntervals >= 1 ? numIntervals : 1;
    // pick interval (nearest multiple of 0.5)
    let interval = Math.floor(widthSize / numIntervals * 2.0) / 2.0;
    // use nearest interval of 0.1 if 0.5 was too large
    interval = interval > 0 ? interval : Math.floor(widthSize / numIntervals * 10.0) / 10.0;
    // if 0.1 was too large, just use real interval
    interval = interval > 0 ? interval : widthSize / numIntervals;
    const intervalWidth = interval / widthSize * width;

    const textHeight = 15;
    const blockHeight = 5;
    // draw blocks
    this.ctx.lineWidth = 1.0;
    this.ctx.strokeRect(offX - 0.5, offY + textHeight - 0.5, intervalWidth * numIntervals + 1.0, blockHeight + 1.0);
    // draw first block
    for(let i = 0; i < firstIntervalDivisions; i++) {
      const off = (i / firstIntervalDivisions) * intervalWidth;
      this.ctx.fillStyle = i % 2 == 0 ? "#000000" : "#ffffff";
      this.ctx.fillRect(offX + off, offY + textHeight, intervalWidth / firstIntervalDivisions, blockHeight);
    }
    // draw normal blocks
    for(let i = 1; i < numIntervals; i++) {
      this.ctx.fillStyle = i % 2 == 0 ? "#ffffff" : "#000000";
      this.ctx.fillRect(offX + i * intervalWidth, offY + textHeight, intervalWidth, blockHeight);
    }
    // draw labels
    this.ctx.font = "14px sans-serif";
    this.ctx.fillStyle = "#000000";
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "bottom";
    for(let i = 0; i <= numIntervals; i++) {
      let label = (Math.round(i * interval * 10.0) / 10.0).toString();
      if(i == numIntervals) {
        label += unit;
      }
      this.ctx.fillText(label, offX + i * intervalWidth, offY + textHeight, intervalWidth); 
    }
  }

  private drawMapScales() {
    const [w, h] = this.viewSize();
    const sizeMi = this.view.widthMiles();
    const sizeKm = sizeMi * 1.609344;

    const barWidth = (w - 100) / w;
    this.drawScale(this.margin[0][0], this.margin[1][0] + h + 25, w * barWidth, sizeMi * barWidth, "mi", 4);
    this.drawScale(this.margin[0][0], this.margin[1][0] + h + 50, w * barWidth, sizeKm * barWidth, "km", 10);
  }

  private drawMapDeclination(offX: number, offY: number) {
    const [w, h] = this.viewSize();
    const declWidth = 80;
    const northHeight = 35;
    const lineHeight = 25;

    // true north
    const [northX, northY] = [offX + declWidth / 2 - 0.5, offY];
    // magnetic north
    const angle = this.declination * Math.PI / 180.0;
    const [mNorthX, mNorthY] = [offX + declWidth / 2 - 0.5 + lineHeight * Math.sin(angle), offY + northHeight - lineHeight *  Math.cos(angle)];

    // draw true north
    this.ctx.strokeStyle = "#000000";
    this.ctx.lineWidth = 1.0;
    this.ctx.beginPath();
    this.ctx.moveTo(offX + declWidth / 2 - 0.5, offY + northHeight);
    this.ctx.lineTo(northX, northY);
    this.ctx.stroke();

    this.ctx.fillStyle = "#000000";
    this.ctx.font = "12px sans-serif";
    this.ctx.textBaseline = "bottom";
    this.ctx.textAlign = "center";
    this.ctx.fillText("N", northX, northY);

    // draw magnetic north
    this.ctx.beginPath();
    this.ctx.moveTo(offX + declWidth / 2 - 0.5, offY + northHeight);
    this.ctx.lineTo(mNorthX, mNorthY);
    this.ctx.stroke();
    if(angle > 0) {
      this.ctx.textAlign = "left";
    } else {
      this.ctx.textAlign = "right";
    }
    this.ctx.fillText("MN", mNorthX, mNorthY);

    this.ctx.font = "14px sans-serif";
    this.ctx.textAlign = "left";
    this.ctx.textBaseline = "bottom";
    this.ctx.fillText(`${this.declination.toFixed(1)}°`, offX + declWidth / 2 + 5, offY + northHeight);
  }

  run() {
    this.callbackId = null;
    // clear canvas
    this.ctx.globalAlpha = 1.0;
    this.ctx.clearRect(0, 0, this.width, this.height);
    const [w, h] = this.viewSize();
    // draw layers
    for(let l = 0; l < this.layers.length; l++) {
      // clear off screen canvas
      this.layers[l].ctx.clearRect(0, 0, w, h);
      // draw to off screen canvas
      this.layers[l].tiles.draw(this.layers[l].ctx, this.view, w, h, 0, 0);
      // draw offscreen canvas to main canvas with transparency
      this.ctx.globalAlpha = this.layers[l].opacity;
      this.ctx.drawImage(this.layers[l].canvas, this.margin[0][0], this.margin[1][0]);
    }

    this.ctx.globalAlpha = 1.0;

    if(this.showDecorators) {
      this.drawLonLatLines();
      this.drawMapScales();
      this.drawMapDeclination(this.margin[0][0] + w - 80, this.margin[1][0] + h + 40);
    }
  }
}

const URLS = [
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}", // USGS Topo
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}.jpg", // ESRI Topo
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}.jpg", // ESRI Topo
  "https://tile.openstreetmap.org/${z}/${x}/${y}.png", // OpenStreetMaps
  "https://caltopo.com/tile/fire/{z}/{x}/{y}.png", // Fire History (caltopo)
  "https://caltopo.com/tile/hs_m315z45s3/{z}/{x}/{y}.png", // Shaded Relief (caltopo)
  "https://caltopo.com/tile/f16a/{z}/{x}/{y}.png", // USFS Topo (2016 green - caltopo)
  "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_FSTopo_01/MapServer/tile/{z}/{y}/{x}", // USFS Topo (white)
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}", // USGS Imagery
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}", // USGS Imagery Topo
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png", // Mapzen Elevation Tile Service (decode: (red * 256 + green + blue / 256) - 32768)
];

let app: MapApp;

function resizeApp() {
  app.resize(window.innerWidth, window.innerHeight);
}

window.onload = function() {
  app = new MapApp('canvas', [
    { url: URLS[0], tileSize: 256, opacity: 1.0 },
    { url: URLS[6], tileSize: 256, opacity: 1.0 },
    { url: URLS[5], tileSize: 256, opacity: 0.15 },
  ], true);
  resizeApp();
};

window.onresize = function() {
  resizeApp();
}