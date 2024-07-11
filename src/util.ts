// maximum zoom level to handle tiles at
export const MAX_ZOOM = 16;

// maximum zoom level to split the feature dataset down to
// this needs to be specified for both dataset preparation and the application
export const MAX_ZOOM_DATA_SPLIT = 9;

export type BoundBox = [[number, number], [number, number]];

// list of longitude, latitude coordinates
export type Route = [number, number][];

// a tile coordinate -- a zoom level, x, and y
// At zoom level 0, there is just the (0,0) tile
// At zoom level 1, there are the (0,0), (0,1), (1,0), (1,1) tiles
// A tile coordinate can be expressed in any zoom level
// for example, the zoom 1 (0, 1) tile is (0, 0.5) at zoom 0
export class TileCoordinate {
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

function deg2rad(deg: number): number {
  return deg * (Math.PI/180)
}

// Get the distance (in miles) between two coordinates
export function coordDistMiles(c0: [number, number], c1: [number, number]): number {
  const [lon1, lat1] = c0;
  const [lon2, lat2] = c1;

  const R = 3959.0; // radius of Earth in miles
  const dLat = deg2rad(lat2-lat1);
  const dLon = deg2rad(lon2-lon1); 
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2); 
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  const d = R * c; // distance in mi
  return d;
}

// Get the length of a route (in miles)
export function routeLengthMiles(route: [number, number][]): number {
  let len = 0;
  for(let i = 1; i < route.length; i++) {
    len += coordDistMiles(route[i-1], route[i]);
  }

  return len;
}

// get point on line (endpoint1, endpoint2) closest to given point
export function closestOnLine(point: [number, number], endpoint1: [number, number], endpoint2: [number, number]): [[number, number], number] {
  const [x,y] = point;
  const [x1,y1] = endpoint1;
  const [x2,y2] = endpoint2;

  const A = x - x1;
  const B = y - y1;
  const C = x2 - x1;
  const D = y2 - y1;

  const dot = A * C + B * D;
  const len_sq = C * C + D * D;
  let param = -1;
  if (len_sq != 0) //in case of 0 length line
      param = dot / len_sq;

  let xx, yy;

  if (param < 0) {
    xx = x1;
    yy = y1;
  }
  else if (param > 1) {
    xx = x2;
    yy = y2;
  }
  else {
    xx = x1 + param * C;
    yy = y1 + param * D;
  }

  const dx = x - xx;
  const dy = y - yy;

  return [[xx, yy], Math.sqrt(dx * dx + dy * dy)];
}

// get distance from point segment to line
// distance is in screen coordinate space, which is not physically meaningful
export function distanceToLine(point: [number, number], endpoint1: [number, number], endpoint2: [number, number]): number {
  const [[xx, yy], dist] = closestOnLine(point, endpoint1, endpoint2);
  return dist;
} 

// convert a decimal longitude/latiude to degrees, minutes, and seconds
export function decimalToDMS(decimal: number): [number, number, number] {
  const degree_sign = Math.sign(decimal);
  decimal = Math.abs(decimal);
  const degree = Math.floor(decimal);
  const minute_float = (decimal - degree) * 60.0;
  const minute = Math.floor(minute_float);
  const second = (minute_float - minute) * 60.0;

  return [degree * degree_sign, minute, second];
}

// convert a degrees, minutes, and seconds longitude/latitude to decimal
export function DMSToDecimal(degree: number, minute: number, seconds: number): number {
  return degree + minute / 60.0 + seconds / 3600.0;
}

export function formatDMSComponents(degree: number, minute: number, seconds: number): string[] {
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

export function formatDMS(degree: number, minute: number, seconds: number): string {
  return formatDMSComponents(degree, minute, seconds).join("");
}

export function formatDegrees(degrees: number): string {
  const [d, m, s] = decimalToDMS(degrees);
  return formatDMS(d, m, s);
}

export function formatDegreesComponents(degrees: number): string[] {
  const [d, m, s] = decimalToDMS(degrees);
  return formatDMSComponents(d, m, s);
}

// convert a endpoint format specifier to concrete url
// zoom, x, and y parameters are expected to be formatted in the url as ${z} or {z}
export function formatTMSUrl(format: string, z: number, x: number, y: number) {
  return (format
    .replace("${z}", z.toString()).replace("${x}", x.toString()).replace("${y}", y.toString())
    .replace("{z}",  z.toString()).replace("{x}",  x.toString()).replace("{y}",  y.toString()));
}

// Tile zoom 0 - 15 encoding
// Tiles zoom + coordinate can be encoded into a single 32 bit integer (with zoom <= 15)
export const MAX_ZOOM_ENCODE = 15;
// Encode a tile to a 32 bit integer, given z <= 15
export function encodeTile(z: number, x: number, y: number): number {
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

export type TileId = [number, number, number];

// decode a tile from a 32 bit integer, returning [z, x, y]
export function decodeTile(tile: number): TileId {
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
export function lineCrossedTilesHorizontal(x0: number, y0: number, x1: number, y1: number): Route {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let res: Route = [];
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
export function getLineCrossedTiles(l0: TileCoordinate, l1: TileCoordinate, zoom: number): TileId[] {
  const [x0, y0] = l0.atZoom(zoom);
  const [x1, y1] = l1.atZoom(zoom);

  const dx = x1 - x0;
  const dy = y1 - y0;

  let res = [];
  if(Math.abs(dy) <= Math.abs(dx)) {
    // force x1 > x0
    if(dx < 0) {
      return getLineCrossedTiles(l1, l0, zoom);
    }
    res = lineCrossedTilesHorizontal(x0, y0, x1, y1);
  } else {
    // force y1 > y0
    if(dy < 0) {
      return getLineCrossedTiles(l1, l0, zoom);
    }
    res = lineCrossedTilesHorizontal(y0, x0, y1, x1).map(([y, x]) => [x, y]);
  }

  return res.map(([x, y]) => [zoom, x, y]);
}

// check if tile0 contains tile1
export function tileContains(tile0: TileId, tile1: TileId): boolean {
  if(tile1[0] < tile0[0]) {
    return false;
  }
  let [x0, y0] = new TileCoordinate(tile0[0], tile0[1], tile0[2]).atZoom(0);
  let tile0Size = new TileCoordinate(tile0[0], 1, 1).atZoom(0)[0];
  let [x1, y1] = new TileCoordinate(tile1[0], tile1[1], tile1[2]).atZoom(0);
  let tile1Size = new TileCoordinate(tile1[0], 1, 1).atZoom(0)[0];
  return (
    x1 >= x0 && 
    x1 + tile1Size <= x0 + tile0Size &&
    y1 >= y0 &&
    y1 + tile1Size <= y0 + tile0Size
  );
}

// Get the smallest tile completely containing the two given tiles
export function joinTiles(tile0: TileId, tile1: TileId): TileId {
  // grow tile0 until it contains tile1
  while(!tileContains(tile0, tile1)) {
    let [x, y] = new TileCoordinate(tile0[0], tile0[1], tile0[2]).atZoom(tile0[0] - 1);
    tile0 = [tile0[0] - 1, Math.floor(x), Math.floor(y)];
  }

  return tile0;
}

// Get the smallest tile completely containing the given tiles
export function tileContaining(tiles: TileId[]): TileId {
  if(tiles.length === 0) {
    return [0, 0, 0];
  }

  let res = tiles[0];
  for(let i = 1; i < tiles.length; i++) {
    res = joinTiles(res, tiles[i]);
  }

  return res;
}

// Given a route (as [longitude, latitude] waypoints), find the smallest tile wholly containing that route
export function tileContainingRoute(route: Route): TileId {
  if(route.length === 0) {
    return [0, 0, 0];
  } else if(route.length === 1) {
    const [x, y] = TileCoordinate.fromLonLat(route[0][0], route[0][1]).atZoom(MAX_ZOOM_ENCODE);
    return [MAX_ZOOM_ENCODE, x, y];
  }

  let res: TileId[] = [];
  for(let i = 0; i < route.length - 1; i++) {
    const p0 = TileCoordinate.fromLonLat(route[i][0], route[i][1]);
    const p1 = TileCoordinate.fromLonLat(route[i + 1][0], route[i + 1][1]);

    const crossed = getLineCrossedTiles(p0, p1, MAX_ZOOM_ENCODE);
    res.push(tileContaining(crossed));
  }

  return tileContaining(res);
}

// calculate a bounding box for a route
export function boundBoxForRoute(route: Route): BoundBox {
  if(route.length === 0) {
    return [[0, 0], [0, 0]];
  }

  let res: BoundBox = [[route[0][0], route[0][1]], [route[0][0], route[0][1]]];
  for(let i = 1; i < route.length; i++) {
    const [x, y] = route[i];
    if(x < res[0][0]) {
      res[0][0] = x;
    }
    if(x > res[1][0]) {
      res[1][0] = x;
    }
    if(y < res[0][1]) {
      res[0][1] = y;
    }
    if(y > res[1][1]) {
      res[1][1] = y;
    }
  }

  return res;
}

function bbOverlap1d(b0: BoundBox, b1: BoundBox, i: number): boolean {
  return b0[1][i] >= b1[0][i] && b1[1][i] >= b0[0][i];
}

// check if two bounding boxes overlap
export function boundBoxOverlap(b0: BoundBox, b1: BoundBox): boolean {
  return bbOverlap1d(b0, b1, 0) && bbOverlap1d(b0, b1, 1);
}

// a set of loaded tile images that can be drawn
export class TileSet {
  zoom: number;
  // tile range (in zoom level coordinates)
  x0: number;
  y0: number;
  x1: number;
  y1: number;

  img: (HTMLImageElement | null)[][];
  loaded: boolean[][];

  // construct a TileSet for the given range, reusing images from old if already loaded there
  constructor(zoom: number, range: BoundBox, old: TileSet[] | undefined, url: string, onloadCallback: () => void) {
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

  getRange(): BoundBox {
    return [[this.x0, this.y0], [this.x1, this.y1]];
  }

  // check if the tile set is fully loaded over the given range
  // zoom does not have to match this set's zoom
  fullyLoaded(zoom: number, range: BoundBox): boolean {
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

export class Viewport {
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

  // return the coordinates of a location within the viewport
  // x and y are in the [0, 1] range
  getCoordinate(x: number, y: number): [number, number] {
    const sx = this.x1 - this.x0;
    const sy = this.y1 - this.y0;

    const rx = this.x0 + x * sx;
    const ry = this.y0 + y * sy;

    return new TileCoordinate(0, rx, ry).toLonLat();
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

  tileZoomLevelRaw(width: number, height: number, tileSize: number): number {
    const sx = this.x1 - this.x0;
    const sy = this.y1 - this.y0;
    // normalize canvas size to num tiles
    width /= tileSize;
    height /= tileSize;

    let zoom = Math.max(Math.log2(width / sx), Math.log2(height / sy));
    zoom = Math.ceil(zoom);
    return zoom;
  }

  // calculate zoom level needed to load images appropriately sized for the given canvas size
  // width, height is the canvas size
  // tileSize is the size of a tile image
  // returns the minimum zoom level needed such that each tile is drawn at or below it's natural size
  tileZoomLevel(width: number, height: number, tileSize: number): number {
    return Math.min(this.tileZoomLevelRaw(width, height, tileSize), MAX_ZOOM);
  }

  // return the range of tiles that need to be loaded to fully display this viewport at zoom
  // returns [topLeft, bottomRight] in zoom level tile coordinates (NOT zoom 0 coordinates)
  neededTiles(zoom: number): BoundBox {
    const t0 = new TileCoordinate(0, this.x0, this.y0);
    const t1 = new TileCoordinate(0, this.x1, this.y1);
    const [t0X, t0Y] = t0.atZoom(zoom);
    const [t1X, t1Y] = t1.atZoom(zoom);
    
    return [
      [Math.floor(t0X), Math.floor(t0Y)],
      [Math.ceil(t1X), Math.ceil(t1Y)]
    ];
  }

  // return the range of tiles covered by this viewport at zoom
  coveredTilesZoom(zoom: number): BoundBox {
    const t0 = new TileCoordinate(0, this.x0, this.y0);
    const t1 = new TileCoordinate(0, this.x1, this.y1);
    const [t0X, t0Y] = t0.atZoom(zoom);
    const [t1X, t1Y] = t1.atZoom(zoom);
    
    return [
      [Math.floor(t0X), Math.floor(t0Y)],
      [Math.floor(t1X), Math.floor(t1Y)]
    ];
  }

  // return all tiles covered by the viewport down to max_zoom
  coveredTiles(max_zoom: number): Set<number> {
    let tiles = new Set<number>();
    for(let zoom = 0; zoom <= max_zoom; zoom++) {
      const bounds = this.coveredTilesZoom(zoom);
      for(let x = bounds[0][0]; x <= bounds[1][0]; x++) {
        for(let y = bounds[0][1]; y <= bounds[1][1]; y++) {
          tiles.add(encodeTile(zoom, x, y));
        }
      }
    }

    return tiles;
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

  // check if the viewport contains or overlaps with the given longitude latitude bound box
  overlapsLonLatBoundBox(bb: BoundBox): boolean {
    const viewBB: BoundBox = [new TileCoordinate(0, this.x0, this.y1).toLonLat(), new TileCoordinate(0, this.x1, this.y0).toLonLat()];
    return boundBoxOverlap(viewBB, bb);
  }
}

// a group of overlapping TileSets of the same area at different zoom levels
// this allows the app to use old tiles to draw the current view while newer tiles are still loading
export class TileSetBuffer {
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

// Feature json format
// Trail format
export interface TrailEntry {
  // internal feature id
  id: number;
  type: "trail";
  // encoded TileId fully containing the trail
  tile: number;
  // bounding box of the trail (in longitude, latitude)
  boundBox: BoundBox;
  // name of the trail
  name: string;
  // longitude, latitude coordinates
  route: Route;
  // trail length (miles)
  length: number;
}

// Site format
export interface SiteEntry {
  // internal feature id
  id: number;
  type: "site";
  // encoded TileId containing the location of the site
  tile: number;
  // boundingBox of the site (just [location, location])
  boundBox: BoundBox;
  // name of the site
  name: string;
  // site type / purpose
  site_type: string;
  // longitude, latitude coordinate
  location: [number, number];
  // url for more information
  url: string | null;
}

export type FeatureEntry = TrailEntry | SiteEntry;

// a set of FeatureEntry's loaded for an area
export class FeatureEntrySet {
  features: { [tile: number]: FeatureEntry[] };
  visibleFeatures: FeatureEntry[];

  constructor() {
    this.features = {};
    this.visibleFeatures = [];
  }

  hasTile(encodedTile: number): FeatureEntry[] | null {
    if(encodedTile in this.features) {
      return this.features[encodedTile];
    } else {
      return null;
    }
  }

  forEach(f: (feature: FeatureEntry) => void) {
    this.visibleFeatures.forEach(f);
  }

  addFeature(feature: FeatureEntry, view: Viewport) {
    if(view.overlapsLonLatBoundBox(feature.boundBox)) {
      this.visibleFeatures.push(feature);
    }
    if(feature.tile in this.features) {
      this.features[feature.tile].push(feature);
    } else {
      this.features[feature.tile] = [feature];
    }
  }

  // add features all with the same tile
  bulkAddFeature(features: FeatureEntry[], tile: number, view: Viewport) {
    if(tile in this.features) {
      this.features[tile].push(...features);
    } else {
      this.features[tile] = features;
    }
    features.forEach((feature) => {
      if(view.overlapsLonLatBoundBox(feature.boundBox)) {
        this.visibleFeatures.push(feature);
      }
    });
  }

  // find the closest feature to the given point
  // return the feature and distance in coordinate distance
  closestFeature(coord: [number, number], excludeId?: number): [FeatureEntry, number] {
    let feature: FeatureEntry;
    let dist = 1e100;

    this.forEach((f) => {
      if(f.type === "trail" && f.id !== excludeId) {
        let minDist = 1e100;
        for(let i = 1; i < f.route.length; i++) {
          minDist = Math.min(minDist, distanceToLine(coord, f.route[i-1], f.route[i]));
        }

        if(minDist < dist) {
          dist = minDist;
          feature = f;
        }
      }
      // TODO: other features
    });

    return [feature, dist];
  }

  // find the closest trail to the given point
  closestTrail(coord: [number, number], excludeId?: number): [TrailEntry, number] {
    // TODO: only return trails
    return this.closestFeature(coord, excludeId) as [TrailEntry, number];
  }

  // find trail by id
  findTrail(id: number): TrailEntry {
    for(let i = 0; i < this.visibleFeatures.length; i++) {
      const feat = this.visibleFeatures[i];
      if(feat.id === id && feat.type === "trail") {
        return feat;
      }
    }
  }
}

// modulo operator that returns positive results for negative operands
export function mod(n: number, m: number) {
  return ((n % m) + m) % m;
}