const MAX_ZOOM = 22;
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
}
// convert a endpoint format specifier to concrete url
// zoom, x, and y parameters are expected to be formatted in the url as ${z} or {z}
function formatTMSUrl(format, z, x, y) {
    return (format
        .replace("${z}", z.toString()).replace("${x}", x.toString()).replace("${y}", y.toString())
        .replace("{z}", z.toString()).replace("{x}", x.toString()).replace("{y}", y.toString()));
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
                let im = old.getTile(zoom, x, y);
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
    // check if the set contains the given tile
    getTile(zoom, x, y) {
        if (zoom != this.zoom) {
            return null;
        }
        const iX = x - this.x0;
        const iY = y - this.y0;
        if (iX < 0 || iY < 0 || x >= this.x1 || y >= this.y1) {
            return null;
        }
        if (!this.loaded[iX][iY]) {
            return null;
        }
        return this.img[iX][iY];
    }
    getRange() {
        return [[this.x0, this.y0], [this.x1, this.y1]];
    }
}
class Viewport {
    constructor(x0, y0, x1, y1) {
        this.x0 = x0;
        this.y0 = y0;
        this.x1 = x1;
        this.y1 = y1;
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
        return Math.ceil(zoom);
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
    // given a TileSet, draw those tiles as seen by this viewport on ctx
    draw(ctx, width, height, tiles) {
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
                ctx.drawImage(im, Math.floor(nX * width), Math.floor(nY * height), Math.ceil(nW), Math.ceil(nH));
            }
        }
    }
}
class App {
    constructor(id, url, tileSize) {
        this.canvas = document.getElementById(id);
        this.ctx = this.canvas.getContext('2d');
        this.width = this.canvas.width;
        this.height = this.canvas.height;
        this.mouseClicked = false;
        this.callbackId = null;
        this.canvas.addEventListener('mousedown', function (e) { this.mousedown(e); }.bind(this));
        this.canvas.addEventListener('mouseup', function (e) { this.mouseup(e); }.bind(this));
        this.canvas.addEventListener('mouseleave', function (e) { this.mouseup(e); }.bind(this));
        this.canvas.addEventListener('mousemove', function (e) { this.mousemove(e); }.bind(this));
        this.canvas.addEventListener('wheel', function (e) { this.wheel(e); }.bind(this));
        this.url = url;
        this.tileSize = tileSize;
        this.view = new Viewport(0.0, 0.0, 1.0, 1.0);
        this.tiles = TileSet.empty();
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
    mousemove(e) {
        if (!this.mouseClicked) {
            return;
        }
        this.view.pan(-(e.offsetX - this.pMouseX) / this.width, -(e.offsetY - this.pMouseY) / this.height);
        this.loadTiles();
        this.run();
        this.pMouseX = e.offsetX;
        this.pMouseY = e.offsetY;
    }
    wheel(e) {
        this.view.zoom(e.deltaY * 0.01, e.offsetX / this.width, e.offsetY / this.height);
        this.loadTiles();
        this.run();
    }
    loadTiles() {
        const zoom = this.view.tileZoomLevel(this.width, this.height, this.tileSize);
        this.tiles = new TileSet(zoom, this.view.neededTiles(zoom), this.tiles, this.url, function () {
            if (this.callbackId == null) {
                this.callbackId = window.requestAnimationFrame(function () { this.run(); }.bind(this));
            }
        }.bind(this));
    }
    resize(w, h) {
        this.width = w;
        this.height = h;
        this.canvas.width = w;
        this.canvas.height = h;
        this.view.matchAspect(this.width, this.height);
        this.loadTiles();
        this.run();
    }
    run() {
        this.callbackId = null;
        // clear canvas
        this.ctx.fillStyle = "white";
        this.ctx.fillRect(0, 0, this.width, this.height);
        // draw tiles
        this.view.draw(this.ctx, this.width, this.height, this.tiles);
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
    app = new App('canvas', URLS[1], 256);
    resizeApp();
};
window.onresize = function () {
    resizeApp();
};
