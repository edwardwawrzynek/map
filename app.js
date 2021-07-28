const MAX_ZOOM = 16;
// a tile coordinate -- a zoom level, x, and y
// At zoom level 0, there is just the (0,0) tile
// At zoom level 1, there are the (0,0), (0,1), (1,0), (1,1) tiles
// A tile coordinate can be expressed in any zoom level
// for example, the zoom 1 (0, 1) tile is (0, 0.5) at zoom 0
class TileCoordinate {
    constructor(zoom, x, y) {
        if (zoom > MAX_ZOOM) {
            throw new Error(`zoom level ${zoom} is higher than maximum zoom ${MAX_ZOOM}`);
        }
        else {
            this.x = x * (1 << (MAX_ZOOM - zoom));
            this.y = y * (1 << (MAX_ZOOM - zoom));
        }
    }
    // Get x,y coordinates for the tile at the specified zoom level
    atZoom(zoom) {
        let factor = Math.pow(2.0, zoom - MAX_ZOOM);
        return [this.x * factor, this.y * factor];
    }
    // Convert to latitude and longitude (using a spherical mercator projection)
    toLonLat() {
        const [x, y] = this.atZoom(0);
        return [
            (x - 0.5) * 360.0,
            (360.0 / Math.PI * Math.atan(Math.exp(-2.0 * Math.PI * y + Math.PI))) - 90.0
        ];
    }
    // calculate the scale at this coordinate
    // returns the horizontal size, in miles, of a 1x1 zoom 0 tile at the coordinate
    scale() {
        const [lon, lat] = this.toLonLat();
        const latSize = Math.cos(lat * Math.PI / 180.0);
        // Earth radius: 3959 mi
        return 3959.0 * 2.0 * Math.PI * latSize;
    }
    // Create a coordinate from latitude and longitude (using a spherical mercator projection)
    static fromLonLat(lon, lat) {
        const x = lon / 360.0 + 0.5;
        const y = 0.5 * (1.0 - 1.0 / Math.PI * Math.log(Math.tan(Math.PI / 4 + (Math.PI / 180.0) * lat / 2.0)));
        return new TileCoordinate(0, x, y);
    }
}
// convert a decimal longitude/latiude to degrees, minutes, and seconds
function decimalToDMS(decimal) {
    const degree_sign = Math.sign(decimal);
    decimal = Math.abs(decimal);
    const degree = Math.floor(decimal);
    const minute_float = (decimal - degree) * 60.0;
    const minute = Math.floor(minute_float);
    const second = (minute_float - minute) * 60.0;
    return [degree * degree_sign, minute, second];
}
// convert a degrees, minutes, and seconds longitude/latitude to decimal
function DMSToDecimal(degree, minute, seconds) {
    return degree + minute / 60.0 + seconds / 3600.0;
}
function formatDMSComponents(degree, minute, seconds) {
    // round seconds to 2 decimal places
    seconds = Math.round(seconds * 100.0) / 100.0;
    if (seconds >= 60.0) {
        seconds -= 60.0;
        minute += 1.0;
    }
    if (Math.abs(seconds) <= 0.01) {
        return [`${String(degree).padStart(2, '0')}°`, `${String(minute).padStart(2, '0')}' `];
    }
    else if (seconds - Math.floor(seconds) <= 0.01) {
        return [`${String(degree).padStart(2, '0')}°`, `${String(minute).padStart(2, '0')}' `, `${String(Math.floor(seconds)).padStart(2, '0')}"`];
    }
    else {
        return [`${String(degree).padStart(2, '0')}°`, `${String(minute).padStart(2, '0')}' `, `${seconds.toFixed(2)}"`];
    }
}
function formatDMS(degree, minute, seconds) {
    return formatDMSComponents(degree, minute, seconds).join("");
}
function formatDegrees(degrees) {
    const [d, m, s] = decimalToDMS(degrees);
    return formatDMS(d, m, s);
}
function formatDegreesComponents(degrees) {
    const [d, m, s] = decimalToDMS(degrees);
    return formatDMSComponents(d, m, s);
}
// convert a endpoint format specifier to concrete url
// zoom, x, and y parameters are expected to be formatted in the url as ${z} or {z}
function formatTMSUrl(format, z, x, y) {
    return (format
        .replace("${z}", z.toString()).replace("${x}", x.toString()).replace("${y}", y.toString())
        .replace("{z}", z.toString()).replace("{x}", x.toString()).replace("{y}", y.toString()));
}
// get magnetic declination for a given location
// (uses NOAA NCEI api)
function getDeclination(lon, lat, callback) {
    fetch(`https://www.ngdc.noaa.gov/geomag-web/calculators/calculateDeclination?lat1=${lat}&lon1=${lon}&resultFormat=json`).then(res => res.json()).then(data => callback(data.result[0].declination));
}
// a set of loaded tile images that can be drawn
class TileSet {
    // construct a TileSet for the given range, reusing images from old if already loaded there
    constructor(zoom, range, old, url, onloadCallback) {
        this.zoom = zoom;
        this.x0 = range[0][0];
        this.y0 = range[0][1];
        this.x1 = range[1][0];
        this.y1 = range[1][1];
        this.img = [];
        this.loaded = [];
        for (let x = this.x0; x < this.x1; x++) {
            this.img.push([]);
            this.loaded.push([]);
            for (let y = this.y0; y < this.y1; y++) {
                let im = null;
                for (let t = 0; t < old.length; t++) {
                    im = old[t].getTile(zoom, x, y);
                    if (im != null)
                        break;
                }
                let loaded = im != null;
                if (loaded) {
                    this.img[this.img.length - 1].push(im);
                }
                else {
                    let newIm = new Image();
                    newIm.onload = function () {
                        this.loaded[x - this.x0][y - this.y0] = true;
                        onloadCallback();
                    }.bind(this);
                    newIm.onerror = function () {
                        // image doesn't exist, but it is still finished loading
                        this.loaded[x - this.x0][y - this.y0] = true;
                    }.bind(this);
                    newIm.src = formatTMSUrl(url, zoom, x, y);
                    this.img[this.img.length - 1].push(newIm);
                }
                this.loaded[this.loaded.length - 1].push(loaded);
            }
        }
    }
    // empty TileSet
    static empty() {
        return new TileSet(0, [[0, 0], [0, 0]], undefined, "", function () { });
    }
    getZoom() {
        return this.zoom;
    }
    tileLoaded(x, y) {
        const iX = x - this.x0;
        const iY = y - this.y0;
        if (iX < 0 || iY < 0 || x >= this.x1 || y >= this.y1) {
            return false;
        }
        if (!this.loaded[iX][iY]) {
            return false;
        }
        return true;
    }
    // check if the set contains the given tile
    getTile(zoom, x, y) {
        if (zoom != this.zoom) {
            return null;
        }
        const iX = x - this.x0;
        const iY = y - this.y0;
        if (!this.tileLoaded(x, y)) {
            return null;
        }
        if (this.img[iX][iY].height === 0) {
            return null;
        }
        return this.img[iX][iY];
    }
    getRange() {
        return [[this.x0, this.y0], [this.x1, this.y1]];
    }
    // check if the tile set is fully loaded over the given range
    // zoom does not have to match this set's zoom
    fullyLoaded(zoom, range) {
        const [t0X, t0Y] = new TileCoordinate(zoom, range[0][0], range[0][1]).atZoom(this.zoom);
        const [t1X, t1Y] = new TileCoordinate(zoom, range[1][0], range[1][1]).atZoom(this.zoom);
        for (let x = Math.floor(t0X); x < Math.ceil(t1X); x++) {
            for (let y = Math.floor(t0Y); y < Math.ceil(t1Y); y++) {
                if (!this.tileLoaded(x, y)) {
                    return false;
                }
            }
        }
        return true;
    }
}
class Viewport {
    constructor(x0, y0, x1, y1) {
        this.x0 = x0;
        this.y0 = y0;
        this.x1 = x1;
        this.y1 = y1;
    }
    // get the width of the viewport in miles
    widthMiles() {
        const tileScale = new TileCoordinate(0, (this.x0 + this.x1) / 2, (this.y0 + this.y1) / 2).scale();
        return tileScale * (this.x1 - this.x0);
    }
    // move the viewport in the (dX, dY) direction
    // dX and dY are in the [0, 1] range, and the map moves proportionally to its current scale
    pan(dX, dY) {
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
    zoom(scale, cX, cY) {
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
    matchAspect(width, height) {
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
    tileZoomLevel(width, height, tileSize) {
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
    neededTiles(zoom) {
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
    drawImage(ctx, width, height, offX, offY, im, x, y, w, h) {
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
    draw(ctx, width, height, offX, offY, tiles) {
        const sx = this.x1 - this.x0;
        const sy = this.y1 - this.y0;
        const [[tX0, tY0], [tX1, tY1]] = tiles.getRange();
        const zoom = tiles.getZoom();
        for (let tX = tX0; tX < tX1; tX++) {
            for (let tY = tY0; tY < tY1; tY++) {
                let im = tiles.getTile(zoom, tX, tY);
                if (im == null) {
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
    centerLonLat() {
        return new TileCoordinate(0, (this.x0 + this.x1) / 2, (this.y0 + this.y1) / 2).toLonLat();
    }
}
// a group of overlapping TileSets of the same area at different zoom levels
// this allows the app to use old tiles to draw the current view while newer tiles are still loading
class TileSetBuffer {
    constructor(url, loadCallback) {
        this.tiles = [TileSet.empty()];
        this.url = url;
        this.loadCallback = loadCallback;
    }
    getTiles() {
        return this.tiles;
    }
    // load a new TileSet for view at zoom, and discard any old TileSets no longer needed
    loadNew(view, zoom) {
        const range = view.neededTiles(zoom);
        // once we hit a tileset that fully covers the range of the image we want, we can remove all sets behind it
        for (let i = 0; i < this.tiles.length; i++) {
            if (this.tiles[i].fullyLoaded(zoom, range)) {
                this.tiles.splice(i + 1, this.tiles.length - i - 1);
            }
        }
        // limit to 4 old tilesets
        if (this.tiles.length > 4) {
            this.tiles.splice(4, this.tiles.length - 4);
        }
        // add new tileset    
        this.tiles.unshift(new TileSet(zoom, range, this.tiles.filter((t) => t.zoom == zoom), this.url, this.loadCallback));
    }
    // draw the tilesets
    draw(ctx, view, width, height, offX, offY) {
        for (let i = this.tiles.length - 1; i >= 0; i--) {
            view.draw(ctx, width, height, offX, offY, this.tiles[i]);
        }
    }
}
// modulo operator that returns positive results for negative operands
function mod(n, m) {
    return ((n % m) + m) % m;
}
const SCROLL_LOAD_DELAY = 350;
class App {
    constructor(id, layers) {
        this.canvas = document.getElementById(id);
        this.ctx = this.canvas.getContext('2d');
        this.width = this.canvas.width;
        this.height = this.canvas.height;
        this.mouseClicked = false;
        this.callbackId = null;
        this.wheelCallbackId = null;
        this.canvas.addEventListener('mousedown', function (e) { this.mousedown(e); }.bind(this));
        this.canvas.addEventListener('mouseup', function (e) { this.mouseup(e); }.bind(this));
        this.canvas.addEventListener('mouseleave', function (e) { this.mouseup(e); }.bind(this));
        this.canvas.addEventListener('mousemove', function (e) { this.mousemove(e); }.bind(this));
        this.canvas.addEventListener('wheel', function (e) { this.wheel(e); }.bind(this));
        this.margin = [[40, 40], [30, 80]];
        this.view = new Viewport(0.0, 0.0, 1.0, 1.0);
        this.declination = 0.0;
        this.declinationGetCallbackId = null;
        this.setLayers(layers);
    }
    setLayers(layers) {
        this.layers = layers.map((layer) => {
            const canvas = document.createElement("canvas");
            canvas.width = this.viewSize()[0];
            canvas.height = this.viewSize()[1];
            return Object.assign(Object.assign({}, layer), { canvas, ctx: canvas.getContext("2d"), tiles: new TileSetBuffer(layer.url, function () {
                    if (this.callbackId == null) {
                        this.callbackId = window.requestAnimationFrame(function () { this.run(); }.bind(this));
                    }
                }.bind(this)) });
        });
        this.loadTiles();
    }
    mousedown(e) {
        this.mouseClicked = true;
        this.pMouseX = e.offsetX;
        this.pMouseY = e.offsetY;
    }
    mouseup(e) {
        this.mouseClicked = false;
    }
    mousePos(x, y) {
        return [
            (x - this.margin[0][0]) / (this.width - this.margin[0][0] - this.margin[0][1]),
            (y - this.margin[1][0]) / (this.height - this.margin[1][0] - this.margin[1][1]),
        ];
    }
    viewSize() {
        return [
            (this.width - this.margin[0][0] - this.margin[0][1]),
            (this.height - this.margin[1][0] - this.margin[1][1])
        ];
    }
    mousemove(e) {
        if (!this.mouseClicked) {
            return;
        }
        const [w, h] = this.viewSize();
        this.view.pan(-(e.offsetX - this.pMouseX) / w, -(e.offsetY - this.pMouseY) / h);
        this.loadTiles();
        this.run();
        this.pMouseX = e.offsetX;
        this.pMouseY = e.offsetY;
    }
    wheel(e) {
        const [x, y] = this.mousePos(e.offsetX, e.offsetY);
        this.view.zoom(e.deltaY * 0.005, x, y);
        // set tile loading to occur SCROLL_LOAD_DELAY after scrolling stops
        if (this.wheelCallbackId != null) {
            window.clearTimeout(this.wheelCallbackId);
        }
        this.wheelCallbackId = window.setTimeout(function () { this.loadTiles(); }.bind(this), SCROLL_LOAD_DELAY);
        this.run();
    }
    loadTiles() {
        for (let l = 0; l < this.layers.length; l++) {
            const zoom = this.view.tileZoomLevel(this.viewSize()[0], this.viewSize()[1], this.layers[l].tileSize);
            this.layers[l].tiles.loadNew(this.view, zoom);
        }
        if (this.declinationGetCallbackId !== null) {
            window.clearTimeout(this.declinationGetCallbackId);
        }
        this.declinationGetCallbackId = window.setTimeout(() => {
            getDeclination(this.view.centerLonLat()[0], this.view.centerLonLat()[1], (decl) => {
                this.declination = decl;
                this.run();
            });
        }, SCROLL_LOAD_DELAY);
    }
    resize(w, h) {
        this.width = w;
        this.height = h;
        this.canvas.width = w;
        this.canvas.height = h;
        this.view.matchAspect(this.width, this.height);
        for (let l = 0; l < this.layers.length; l++) {
            this.layers[l].canvas.width = this.viewSize()[0];
            this.layers[l].canvas.height = this.viewSize()[1];
        }
        this.loadTiles();
        this.run();
    }
    // pick longitude and latitude line distance (in degrees)
    lonLatInterval(sizePixels, degreeRange) {
        const maxNum = Math.floor(sizePixels / 140.0);
        const dist = degreeRange / maxNum;
        const [d, m, s] = decimalToDMS(dist);
        return DMSToDecimal(Math.round(d), Math.round(m), Math.round(s));
    }
    // return degree values to draw longitude/latitude indicators at
    lonLatIndicatorLocs(sizePixels, lowDegrees, highDegrees) {
        const interval = this.lonLatInterval(sizePixels, Math.abs(highDegrees - lowDegrees));
        let res = [];
        const start = lowDegrees + interval - mod(lowDegrees, interval);
        const end = highDegrees - highDegrees % interval;
        for (let i = start; i <= end; i += interval) {
            res.push(i);
        }
        return res;
    }
    xTileToCanvasPos(x) {
        const normal = (x - this.view.x0) / (this.view.x1 - this.view.x0);
        return Math.floor(this.margin[0][0] + normal * this.viewSize()[0]);
    }
    yTileToCanvasPos(y) {
        const normal = (y - this.view.y0) / (this.view.y1 - this.view.y0);
        return Math.floor(this.margin[1][0] + normal * this.viewSize()[1]);
    }
    // draw longitude and latitude indicators
    drawLonLatLines() {
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
        for (let i = 0; i < lonIndicators.length; i++) {
            const lon = lonIndicators[i];
            let x = TileCoordinate.fromLonLat(lon, 0.0).atZoom(0)[0];
            x = this.xTileToCanvasPos(x);
            if (x - this.margin[0][0] < lineLen || this.margin[0][0] + this.viewSize()[0] - x < lineLen) {
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
        for (let i = 0; i < latIndicators.length; i++) {
            const lat = latIndicators[i];
            let y = TileCoordinate.fromLonLat(0.0, lat).atZoom(0)[1];
            y = this.yTileToCanvasPos(y);
            if (y - this.margin[1][0] < lineLen || this.margin[1][0] + this.viewSize()[1] - y < lineLen) {
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
            let writeLines = (lines, x, y) => {
                let interval = 17;
                let offset = -(lines.length / 2) + 0.5;
                for (let i = 0; i < lines.length; i++) {
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
    drawScale(offX, offY, width, widthSize, unit, firstIntervalDivisions) {
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
        for (let i = 0; i < firstIntervalDivisions; i++) {
            const off = (i / firstIntervalDivisions) * intervalWidth;
            this.ctx.fillStyle = i % 2 == 0 ? "#000000" : "#ffffff";
            this.ctx.fillRect(offX + off, offY + textHeight, intervalWidth / firstIntervalDivisions, blockHeight);
        }
        // draw normal blocks
        for (let i = 1; i < numIntervals; i++) {
            this.ctx.fillStyle = i % 2 == 0 ? "#ffffff" : "#000000";
            this.ctx.fillRect(offX + i * intervalWidth, offY + textHeight, intervalWidth, blockHeight);
        }
        // draw labels
        this.ctx.font = "14px sans-serif";
        this.ctx.fillStyle = "#000000";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "bottom";
        for (let i = 0; i <= numIntervals; i++) {
            let label = (Math.round(i * interval * 10.0) / 10.0).toString();
            if (i == numIntervals) {
                label += unit;
            }
            this.ctx.fillText(label, offX + i * intervalWidth, offY + textHeight, intervalWidth);
        }
    }
    drawMapScales() {
        const [w, h] = this.viewSize();
        const sizeMi = this.view.widthMiles();
        const sizeKm = sizeMi * 1.609344;
        const barWidth = (w - 100) / w;
        this.drawScale(this.margin[0][0], this.margin[1][0] + h + 25, w * barWidth, sizeMi * barWidth, "mi", 4);
        this.drawScale(this.margin[0][0], this.margin[1][0] + h + 50, w * barWidth, sizeKm * barWidth, "km", 10);
    }
    drawMapDeclination(offX, offY) {
        const [w, h] = this.viewSize();
        const declWidth = 80;
        const northHeight = 35;
        const lineHeight = 25;
        // true north
        const [northX, northY] = [offX + declWidth / 2 - 0.5, offY];
        // magnetic north
        const angle = this.declination * Math.PI / 180.0;
        const [mNorthX, mNorthY] = [offX + declWidth / 2 - 0.5 + lineHeight * Math.sin(angle), offY + northHeight - lineHeight * Math.cos(angle)];
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
        if (angle > 0) {
            this.ctx.textAlign = "left";
        }
        else {
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
        for (let l = 0; l < this.layers.length; l++) {
            // clear off screen canvas
            this.layers[l].ctx.clearRect(0, 0, w, h);
            // draw to off screen canvas
            this.layers[l].tiles.draw(this.layers[l].ctx, this.view, w, h, 0, 0);
            // draw offscreen canvas to main canvas with transparency
            this.ctx.globalAlpha = this.layers[l].opacity;
            this.ctx.drawImage(this.layers[l].canvas, this.margin[0][0], this.margin[1][0]);
        }
        this.ctx.globalAlpha = 1.0;
        this.drawLonLatLines();
        this.drawMapScales();
        this.drawMapDeclination(this.margin[0][0] + w - 80, this.margin[1][0] + h + 40);
    }
}
const URLS = [
    "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}.jpg",
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}.jpg",
    "https://tile.openstreetmap.org/${z}/${x}/${y}.png",
    "https://caltopo.com/tile/fire/{z}/{x}/{y}.png",
    "https://caltopo.com/tile/hs_m315z45s3/{z}/{x}/{y}.png",
    "https://caltopo.com/tile/f16a/{z}/{x}/{y}.png",
    "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_FSTopo_01/MapServer/tile/{z}/{y}/{x}",
    "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
    "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}", // USGS Imagery Topo
];
let app;
function resizeApp() {
    app.resize(window.innerWidth, window.innerHeight);
}
window.onload = function () {
    app = new App('canvas', [
        { url: URLS[0], tileSize: 256, opacity: 1.0 },
        { url: URLS[6], tileSize: 256, opacity: 1.0 },
        { url: URLS[5], tileSize: 256, opacity: 0.15 },
    ]);
    resizeApp();
};
window.onresize = function () {
    resizeApp();
};
