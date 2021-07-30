const MAX_ZOOM = 16;

// a tile coordinate -- a zoom level, x, and y
// At zoom level 0, there is just the (0,0) tile
// At zoom level 1, there are the (0,0), (0,1), (1,0), (1,1) tiles
// A tile coordinate can be expressed in any zoom level
// for example, the zoom 1 (0, 1) tile is (0, 0.5) at zoom 0
class TileCoordinate {
  // represent tiles at MAX_ZOOM (to mostly storing floating point coordinates)
  x: number;
  y: number;

  constructor(zoom: number, x: number, y: number) {
    if(zoom > MAX_ZOOM) {
      throw new Error(`zoom level ${zoom} is higher than maximum zoom ${MAX_ZOOM}`);
    } else {
      this.x = x * (1 << (MAX_ZOOM - zoom));
      this.y = y * (1 << (MAX_ZOOM - zoom));
    }
  }

  // Get x,y coordinates for the tile at the specified zoom level
  atZoom(zoom: number): [number, number] {
    let factor = Math.pow(2.0, zoom - MAX_ZOOM);
    return [this.x * factor, this.y * factor];
  }

  // Convert to latitude and longitude (using a spherical mercator projection)
  toLonLat(): [number, number] {
    const [x, y] = this.atZoom(0);
    return [
      (x - 0.5) * 360.0,
      (360.0 / Math.PI * Math.atan(Math.exp(-2.0 * Math.PI * y + Math.PI))) - 90.0
    ];
  }

  // calculate the scale at this coordinate
  // returns the horizontal size, in miles, of a 1x1 zoom 0 tile at the coordinate
  scale(): number {
    const [lon, lat] = this.toLonLat();
    const latSize = Math.cos(lat * Math.PI / 180.0);
    // Earth radius: 3959 mi
    return 3959.0 * 2.0 * Math.PI * latSize;
  }

  // Create a coordinate from latitude and longitude (using a spherical mercator projection)
  static fromLonLat(lon: number, lat: number): TileCoordinate {
    const x = lon / 360.0 + 0.5;
    const y = 0.5 * (1.0 - 1.0 / Math.PI * Math.log(Math.tan(Math.PI / 4 + (Math.PI / 180.0) * lat / 2.0)));

    return new TileCoordinate(0, x, y);
  }
}

// convert a decimal longitude/latiude to degrees, minutes, and seconds
function decimalToDMS(decimal: number): [number, number, number] {
  const degree_sign = Math.sign(decimal);
  decimal = Math.abs(decimal);
  const degree = Math.floor(decimal);
  const minute_float = (decimal - degree) * 60.0;
  const minute = Math.floor(minute_float);
  const second = (minute_float - minute) * 60.0;

  return [degree * degree_sign, minute, second];
}

// convert a degrees, minutes, and seconds longitude/latitude to decimal
function DMSToDecimal(degree: number, minute: number, seconds: number): number {
  return degree + minute / 60.0 + seconds / 3600.0;
}

function formatDMSComponents(degree: number, minute: number, seconds: number): string[] {
  // round seconds to 2 decimal places
  seconds = Math.round(seconds * 100.0) / 100.0;
  if(seconds >= 60.0) {
    seconds -= 60.0;
    minute += 1.0;
  }

  if(Math.abs(seconds) <= 0.01) {
    return [`${String(degree).padStart(2, '0')}°`, `${String(minute).padStart(2, '0')}' `];
  } else if(seconds - Math.floor(seconds) <= 0.01) {
    return [`${String(degree).padStart(2, '0')}°`, `${String(minute).padStart(2, '0')}' `, `${String(Math.floor(seconds)).padStart(2, '0')}"`];
  } else {
    return [`${String(degree).padStart(2, '0')}°`, `${String(minute).padStart(2, '0')}' `, `${seconds.toFixed(2)}"`];
  }
}

function formatDMS(degree: number, minute: number, seconds: number): string {
  return formatDMSComponents(degree, minute, seconds).join("");
}

function formatDegrees(degrees: number): string {
  const [d, m, s] = decimalToDMS(degrees);
  return formatDMS(d, m, s);
}

function formatDegreesComponents(degrees: number): string[] {
  const [d, m, s] = decimalToDMS(degrees);
  return formatDMSComponents(d, m, s);
}

// convert a endpoint format specifier to concrete url
// zoom, x, and y parameters are expected to be formatted in the url as ${z} or {z}
function formatTMSUrl(format: string, z: number, x: number, y: number) {
  return (format
    .replace("${z}", z.toString()).replace("${x}", x.toString()).replace("${y}", y.toString())
    .replace("{z}",  z.toString()).replace("{x}",  x.toString()).replace("{y}",  y.toString()));
}

// Tile zoom 0 - 15 encoding
// Tiles zoom + coordinate can be encoded into a single 32 bit integer (with zoom <= 15)
const MAX_ZOOM_ENCODE = 15;
// Encode a tile to a 32 bit integer, given z <= 15
function encodeTile(z: number, x: number, y: number): number {
  let res = 0;
  // two bit header
  // 0b11 = zoom 15 => x and y follow
  // 0b10 = zoom 14 => 0b00, x, and y follow
  // 0b00 = zoom 0 - 13 => zoom (4 bits), padding (if needed), x, and y follow
  let header = 0b00;
  if(z === 15) {
    header = 0b11;
  } else if(z === 14) {
    header = 0b10;
  }
  // write header
  res += header << 30;
  // write zoom
  if(z < 14) {
    res += (z & 0b1111) << 26;
  }
  // write x and y
  res += x & ((1 << z) - 1);
  res += (y & ((1 << z) - 1)) << z;

  return res;
}

type TileId = [number, number, number];

// decode a tile from a 32 bit integer, returning [z, x, y]
function decodeTile(tile: number): TileId {
  let z, x, y;
  let header = (tile >> 30) & 0b11;
  if(header === 0b11) {
    z = 15;
  } else if (header === 0b10) {
    z = 14;
  } else {
    z = (tile >> 26) & 0b1111;
  }

  x = tile & ((1 << z) - 1);
  y = (tile >> z) & ((1 << z) - 1);
  return [z, x, y];
}

// Calculate the cells crossed by a horizontal-ish line (|dy/dy| <= 1 )
function lineCrossedTilesHorizontal(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let res: [number, number][] = [];
  let x = x0;
  while(x < x1) {
    // pick next x coordinate to examine, which is the next whole x (or x1 if next whole x is greater)
    let nextX;
    if(x === x0) {
      nextX = Math.ceil(x);
    } else if (x + 1 > x1) {
      nextX = x1;
    } else {
      nextX = x + 1;
    }

    // find y for this + next x, and mark cells contained within as crossed
    const y = (x: number) => y0 + dy * ((x - x0) / dx);
    const bound0 = y(x);
    const bound1 = y(nextX);
    const lowY = Math.floor(Math.min(bound0, bound1));
    const highY = Math.floor(Math.max(bound0, bound1));
    for(let hitY = lowY; hitY <= highY; hitY++) {
      res.push([Math.floor(x), hitY]);
    }

    x = nextX;
  }

  return res;
}

// Given two locations, calculate all of the tiles that they cross at the given zoom level
function getLineCrossedTiles(l0: TileCoordinate, l1: TileCoordinate, zoom: number): TileId[] {
  const [x0, y0] = l0.atZoom(zoom);
  const [x1, y1] = l1.atZoom(zoom);

  const dx = x1 - x0;
  const dy = y1 - y0;

  let res = [];
  if(Math.abs(dy) <= Math.abs(dx)) {
    res = lineCrossedTilesHorizontal(x0, y0, x1, y1);
  } else {
    res = lineCrossedTilesHorizontal(y0, x0, y1, x1).map(([y, x]) => [x, y]);
  }

  return res.map(([x, y]) => [zoom, x, y]);
}

// a set of loaded tile images that can be drawn
class TileSet {
  zoom: number;
  // tile range (in zoom level coordinates)
  x0: number;
  y0: number;
  x1: number;
  y1: number;

  img: (HTMLImageElement | null)[][];
  loaded: boolean[][];

  // construct a TileSet for the given range, reusing images from old if already loaded there
  constructor(zoom: number, range: [[number, number], [number, number]], old: TileSet[] | undefined, url: string, onloadCallback: () => void) {
    this.zoom = zoom;
    this.x0 = range[0][0];
    this.y0 = range[0][1];
    this.x1 = range[1][0];
    this.y1 = range[1][1];

    this.img = [];
    this.loaded = [];

    for(let x = this.x0; x < this.x1; x++) {
      this.img.push([]);
      this.loaded.push([]);
      for(let y = this.y0; y < this.y1; y++) {
        let im = null;
        if(old !== undefined) {
          for(let t = 0; t < old.length; t++) {
            im = old[t].getTile(zoom, x, y);
            if(im != null) break;
          }
        }
        let loaded = im != null;
        if(loaded) {
          this.img[this.img.length - 1].push(im);
        } else {
          let newIm = new Image();
          newIm.onload = () => {
            this.loaded[x - this.x0][y - this.y0] = true;
            onloadCallback();
          };
          newIm.onerror = () => {
            // image doesn't exist, but it is still finished loading
            this.loaded[x - this.x0][y - this.y0] = true;
          };
          newIm.src = formatTMSUrl(url, zoom, x, y);
          this.img[this.img.length - 1].push(newIm);
        }
        this.loaded[this.loaded.length - 1].push(loaded);
      }
    }
  }

  // empty TileSet
  static empty(): TileSet {
    return new TileSet(0, [[0, 0], [0, 0]], undefined, "", function() {});
  }

  getZoom(): number {
    return this.zoom;
  }

  private tileLoaded(x: number, y: number): boolean {
    const iX = x - this.x0;
    const iY = y - this.y0;

    if(iX < 0 || iY < 0 || x >= this.x1 || y >= this.y1) {
      return false;
    }

    if(!this.loaded[iX][iY]) {
      return false;
    }

    return true;
  }

  // check if the set contains the given tile
  getTile(zoom: number, x: number, y: number): HTMLImageElement | null {
    if(zoom != this.zoom) {
      return null;
    }

    const iX = x - this.x0;
    const iY = y - this.y0;

    if(!this.tileLoaded(x, y)) {
      return null;
    }

    if(this.img[iX][iY]?.height === 0) {
      return null;
    }

    return this.img[iX][iY];
  }

  getRange(): [[number, number], [number, number]] {
    return [[this.x0, this.y0], [this.x1, this.y1]];
  }

  // check if the tile set is fully loaded over the given range
  // zoom does not have to match this set's zoom
  fullyLoaded(zoom: number, range: [[number, number], [number, number]]): boolean {
    const [t0X, t0Y] = new TileCoordinate(zoom, range[0][0], range[0][1]).atZoom(this.zoom);
    const [t1X, t1Y] = new TileCoordinate(zoom, range[1][0], range[1][1]).atZoom(this.zoom);
    for(let x = Math.floor(t0X); x < Math.ceil(t1X); x++) {
      for(let y = Math.floor(t0Y); y < Math.ceil(t1Y); y++) {
        if(!this.tileLoaded(x, y)) {
          return false;
        }
      }
    }

    return true;
  }
}

class Viewport {
  // viewport top left and bottom right (zoom 0 tile space)
  x0: number;
  y0: number;
  x1: number;
  y1: number;

  constructor(x0: number, y0: number, x1: number, y1: number) {
    this.x0 = x0;
    this.y0 = y0;
    this.x1 = x1;
    this.y1 = y1;
  }

  // get the width of the viewport in miles
  widthMiles(): number {
    const tileScale = new TileCoordinate(0, (this.x0 + this.x1) / 2, (this.y0 + this.y1) / 2).scale();
    return tileScale * (this.x1 - this.x0);
  }

  // move the viewport in the (dX, dY) direction
  // dX and dY are in the [0, 1] range, and the map moves proportionally to its current scale
  pan(dX: number, dY: number) {
    const sx = this.x1 - this.x0;
    const sy = this.y1 - this.y0;
    this.x0 += (dX * sx);
    this.x1 += (dX * sx);
    this.y0 += (dY * sy);
    this.y1 += (dY * sy);
  }

  // zoom the viewport by scale (exponential growth/decay), centered onto/away from (cX, cY)
  // cX and cY are in the [0, 1] range
  // scale 1.0 doubles the size of the map, 2.0 quadruples it, 0.5 halves it, etc
  zoom(scale: number, cX: number, cY: number) {
    const sx = this.x1 - this.x0;
    const sy = this.y1 - this.y0;

    // normalize center to tile space
    cX = this.x0 + cX * sx;
    cY = this.y0 + cY * sy;

    // calculate vectors from (cX, cY) to (x0, y0) and (x1, y1)
    let d0X = this.x0 - cX;
    let d0Y = this.y0 - cY;
    let d1X = this.x1 - cX;
    let d1Y = this.y1 - cY;

    // scale those vectors
    const factor = Math.pow(2.0, scale);
    d0X *= factor;
    d0Y *= factor;
    d1X *= factor;
    d1Y *= factor;

    // calculate new corners as (cX, cY) + scaled vectors
    this.x0 = cX + d0X;
    this.y0 = cY + d0Y;
    this.x1 = cX + d1X;
    this.y1 = cY + d1Y;
  }

  // make the viewport match the given aspect ratio (by adjusting width)
  matchAspect(width: number, height: number) {
    let sx = this.x1 - this.x0;
    const cx = (this.x0 + this.x1) / 2.0;
    const sy = this.y1 - this.y0;

    sx = sy * (width / height);

    this.x0 = cx - sx * 0.5;
    this.x1 = cx + sx * 0.5;
  }

  // calculate zoom level needed to load images appropriately sized for the given canvas size
  // width, height is the canvas size
  // tileSize is the size of a tile image
  // returns the minimum zoom level needed such that each tile is drawn at or below it's natural size
  tileZoomLevel(width: number, height: number, tileSize: number): number {
    const sx = this.x1 - this.x0;
    const sy = this.y1 - this.y0;
    // normalize canvas size to num tiles
    width /= tileSize;
    height /= tileSize;

    let zoom = Math.max(Math.log2(width / sx), Math.log2(height / sy));
    zoom = Math.ceil(zoom);
    return Math.min(zoom, MAX_ZOOM);
  }

  // return the range of tiles that need to be loaded to fully display this viewport at zoom
  // returns [topLeft, bottomRight] in zoom level tile coordinates (NOT zoom 0 coordinates)
  neededTiles(zoom: number): [[number, number], [number, number]] {
    const t0 = new TileCoordinate(0, this.x0, this.y0);
    const t1 = new TileCoordinate(0, this.x1, this.y1);
    const [t0X, t0Y] = t0.atZoom(zoom);
    const [t1X, t1Y] = t1.atZoom(zoom);
    
    return [
      [Math.floor(t0X), Math.floor(t0Y)],
      [Math.ceil(t1X), Math.ceil(t1Y)]
    ];
  }

  // draw an image on ctx at the given x, y and w, h, and only draw the part of that image within the subsection of the canvas (offX, offY, width, height)
  private drawImage(ctx: CanvasRenderingContext2D, width: number, height: number, offX: number, offY: number, im: HTMLImageElement, x: number, y: number, w: number, h: number) {
    // left and top overflow into margin
    const hX = Math.max(offX - x, 0);
    const hY = Math.max(offY - y, 0);
    // bottom and right overflow into margin
    const lX = Math.max((x + w) - (offX + width), 0);
    const lY = Math.max((y + h) - (offY + height), 0);

    const sx = hX / w * im.width;
    const sy = hY / h * im.height;

    const cx = lX / w * im.width;
    const cy = lY / h * im.height;

    const sw = im.width - sx - cx;
    const sh = im.height - sy - cy;

    ctx.drawImage(im, sx, sy, sw, sh, Math.max(x, offX), Math.max(y, offY), w - hX - lX, h - hY - lY);
  }

  // given a TileSet, draw those tiles as seen by this viewport on ctx
  draw(ctx: CanvasRenderingContext2D, width: number, height: number, offX: number, offY: number, tiles: TileSet) {
    const sx = this.x1 - this.x0;
    const sy = this.y1 - this.y0;

    const [[tX0, tY0], [tX1, tY1]] = tiles.getRange();
    const zoom = tiles.getZoom();

    for(let tX = tX0; tX < tX1; tX++) {
      for(let tY = tY0; tY < tY1; tY++) {
        let im = tiles.getTile(zoom, tX, tY);
        if(im == null) {
          continue;
        }
        // get tile coordinates in zoom 0 space
        const [x, y] = new TileCoordinate(zoom, tX, tY).atZoom(0);
        // convert to viewport space
        const [nX, nY] = [(x - this.x0) / sx, (y - this.y0) / sy];
        const scale = Math.pow(2.0, zoom);
        const [nW, nH] = [width / (scale * sx), height / (scale * sy)];

        this.drawImage(ctx, width, height, offX, offY, im, Math.floor(nX * width) + offX, Math.floor(nY * height) + offY, Math.ceil(nW), Math.ceil(nH));
      }
    }
  }

  // get coordinates of the center of the viewport
  centerLonLat(): [number, number] {
    return new TileCoordinate(0, (this.x0 + this.x1) / 2, (this.y0 + this.y1) / 2).toLonLat();
  }
}

// a group of overlapping TileSets of the same area at different zoom levels
// this allows the app to use old tiles to draw the current view while newer tiles are still loading
class TileSetBuffer {
  tiles: TileSet[];
  url: string;
  loadCallback: () => void;

  constructor(url: string, loadCallback: () => void) {
    this.tiles = [TileSet.empty()];
    this.url = url;
    this.loadCallback = loadCallback;
  }

  getTiles() {
    return this.tiles;
  }

  // load a new TileSet for view at zoom, and discard any old TileSets no longer needed
  loadNew(view: Viewport, zoom: number) {
    const range = view.neededTiles(zoom);
    // once we hit a tileset that fully covers the range of the image we want, we can remove all sets behind it
    for(let i = 0; i < this.tiles.length; i++) {
      if(this.tiles[i].fullyLoaded(zoom, range)) {
        this.tiles.splice(i + 1, this.tiles.length - i - 1);
      }
    }
    // limit to 4 old tilesets
    if(this.tiles.length > 4) {
      this.tiles.splice(4, this.tiles.length - 4);
    }

    // add new tileset    
    this.tiles.unshift(new TileSet(zoom, range, this.tiles.filter((t) => t.zoom == zoom), this.url, this.loadCallback));
  }

  // draw the tilesets
  draw(ctx: CanvasRenderingContext2D, view: Viewport, width: number, height: number, offX: number, offY: number) {
    for(let i = this.tiles.length - 1; i >= 0; i--) {
      view.draw(ctx, width, height, offX, offY, this.tiles[i]);
    }
  }
}

// modulo operator that returns positive results for negative operands
function mod(n: number, m: number) {
  return ((n % m) + m) % m;
}