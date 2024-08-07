import { closestOnLine, decimalToDMS, DMSToDecimal, encodeTile, FeatureEntry, FeatureEntrySet, formatDegrees, formatDegreesComponents, MAX_ZOOM_DATA_SPLIT, MAX_ZOOM_ENCODE, mod, Route, routeLengthMiles, TileCoordinate, TileSetBuffer, TrailEntry, Viewport } from './util';
import oboe from 'oboe';
import Dexie, { DexieOptions } from 'dexie';
import './style.css';
import trails from "./trails.hessie.json";

// distance threshold for trails to be considered intersecting
const TRAIL_INTERSECTION_THRESH = 2e-4;

// number of intersections to consider when route finding
const ROUTE_FINDING_DEPTH = 8;

// get magnetic declination for a given location
// (uses NOAA NCEI api)
function getDeclination(lon: number, lat: number, callback: (decl: number) => void) {
  fetch(`https://www.ngdc.noaa.gov/geomag-web/calculators/calculateDeclination?lat1=${lat}&lon1=${lon}&key=zNEw7&resultFormat=json`).then(res => res.json()).then(data => callback(data.result[0].declination));
}

interface TrailPoint {
  trail: TrailEntry,
  pt: [number, number]
};

// feature database handles adding and looking up features in a given area
class FeatureDatabase extends Dexie {
  features: Dexie.Table<FeatureEntry, number>;

  constructor() {
    super("features");
    this.version(1).stores({
      features: "&id, tile, name"
    });

    this.onError = this.onError.bind(this);
  }

  onError(reason: any) {
    console.error(`DB Error: ${reason}`);
  }

  clear() {
    this.transaction("rw", this.features, async () => {
      this.features.clear();
    }).catch(this.onError);
  }

  loadFromJSON(path: string, doneCallback: () => void) {
    this.transaction("rw", this.features, async () => {
      oboe(path).node("trails.*", async (trail: TrailEntry) => {
        await this.features.put(trail).catch(this.onError);

        return oboe.drop;
      }).fail((fail) => {
        console.log(`JSON fail: ${fail}`);
      });
    }).then(() => {
      doneCallback();
    }).catch(this.onError);
  }

  featuresInView(view: Viewport, oldFeatures: FeatureEntrySet): Promise<FeatureEntrySet> {
    return this.transaction("r", this.features, async () => {
      let res = new FeatureEntrySet();
      for (let z = MAX_ZOOM_ENCODE; z >= 0; z--) {
        const tiles = view.neededTiles(z);
        for (let x = tiles[0][0]; x <= tiles[1][0]; x++) {
          for (let y = tiles[0][1]; y <= tiles[1][1]; y++) {
            const tile = encodeTile(z, x, y);
            const features = oldFeatures.hasTile(tile) ?? await this.features.where("tile").equals(tile).toArray();
            res.bulkAddFeature(features, tile, view);
          }
        }
      }

      return res;
    });
  }
}

// a path between a set of waypoints
// the path may have straight-line sections or follow a set of features
interface PathPoint {
  // coordinate of this point
  coord: [number, number];
  // whether to follow features from this to the next point
  followFeatures: boolean;
};

// a trail intersection point
interface Intersection {
  point: [number, number];
  trail0Id: number;
  trail1Id: number;
};

class Path {
  // the points defining the path
  points: PathPoint[];
  // the resulting route from the path
  route: [number, number][];

  constructor() {
    this.points = [];
    this.route = [];
  }

  // find the on-trail point closest to the given point
  // or the point if no trail is within threshold
  private static nearestPoint(point: [number, number], features: FeatureEntrySet, distThreshold?: number): TrailPoint {
    const [feature, dist] = features.closestTrail(point);

    let closest = point;
    let minDist = 1e100;
    if(feature.type == "trail") {
      for(let i = 1; i < feature.route.length; i++) {
        const [pt, dist] = closestOnLine(point, feature.route[i-1], feature.route[i]);
        if(dist < minDist) {
          minDist = dist;
          closest = pt;
        }
      }
    }

    if(distThreshold === undefined || minDist < distThreshold) {
      return {trail: feature, pt: closest};
    } else {
      return {trail: undefined, pt: point};
    }
  }

  // distance between points
  private static dist(p0: [number, number], p1: [number, number]): number {
    return Math.sqrt(Math.pow(p0[0] - p1[0], 2) + Math.pow(p0[1] - p1[1], 2));
  }

  // check if two points are the same
  private static pointsEqual(p0: [number, number], p1: [number, number]): boolean {
    return Path.dist(p0, p1) < 1e-5;
  }

  // find the index of the waypoint on the route closest to pt, and if that point is the same as pt
  private static routePointIndex(pt: TrailPoint): number {
    let minDist = 1e100;
    let minIndex = -1;
    for(let i = 0; i < pt.trail.route.length; i++) {
      const iPt = pt.trail.route[i];
      const dist = Path.dist(iPt, pt.pt);
      if(dist < minDist) {
        minDist = dist;
        minIndex = i;
      }
    }

    return minIndex;
  }

  // get a route between points on the same feature
  private static routeOnTrail(start: TrailPoint, end: TrailPoint): [number, number][] {
    let route: [number, number][] = [];

    // find indexes of points
    let startIndex = Path.routePointIndex(start);
    let endIndex = Path.routePointIndex(end);
    if(startIndex === -1 || endIndex === -1) {
      return undefined;
    }

    if(startIndex === endIndex) {
      // start and end are the same point, so we went nowhere
      return [end.pt];
    }
    // determine direction of travel
    const dir = (endIndex - startIndex) / Math.abs(endIndex - startIndex);
    // refine start and end waypoints to avoid doubling back
    if(Path.dist(start.pt, start.trail.route[startIndex + dir]) < Path.dist(start.trail.route[startIndex], start.trail.route[startIndex + dir])) {
      startIndex += dir;
    }
    if(Path.dist(end.pt, start.trail.route[endIndex - dir]) < Path.dist(start.trail.route[endIndex], start.trail.route[endIndex - dir])) {
      endIndex -= dir;
    }

    for(let i = startIndex; i != endIndex; i+= dir) {
      route.push(start.trail.route[i]);
    }
    const endWaypoint = start.trail.route[endIndex];
    route.push(endWaypoint);
    if(!Path.pointsEqual(endWaypoint, end.pt)) {
      route.push(end.pt);
    }

    return route;
  }

  // find all intersections between id0 and id1
  private static matchIntersect(intersect: Intersection[], id0: number, id1: number): Intersection[] {
    return intersect.filter((i) => (i.trail0Id === id0 && i.trail1Id === id1) || (i.trail1Id === id0 && i.trail0Id === id1));
  }

  // matching all intersections containing id, and return the set of matching and not matching intersections
  private static splitIntersects(intersect: Intersection[], id: number): [Intersection[], Intersection[]] {
    let match: Intersection[] = [];
    let noMatch: Intersection[] = [];

    intersect.forEach((i) => {
      if(i.trail0Id === id || i.trail1Id === id) {
        match.push(i);
      } else {
        noMatch.push(i);
      }
    })

    return [match, noMatch];
  }

  // return all trail intersections between trails in features
  private static findTrailIntersections(features: FeatureEntrySet): Intersection[] {
    let intersect: Intersection[] = [];

    features.forEach((feature) => {
      if(feature.type === "trail") {
        const startPoint = feature.route[0];
        const endPoint = feature.route[feature.route.length - 1];
        // check if any other trail is near the endpoints of the route
        const [start, startDist] = features.closestTrail(startPoint, feature.id);
        const [end, endDist] = features.closestTrail(endPoint, feature.id);

        if(startDist < TRAIL_INTERSECTION_THRESH) {
          if(!Path.matchIntersect(intersect, feature.id, start.id).some((i) => Path.dist(i.point, startPoint) < TRAIL_INTERSECTION_THRESH)) {
            intersect.push({
              point: startPoint,
              trail0Id: feature.id,
              trail1Id: start.id
            });
          }
        }
        if(endDist < TRAIL_INTERSECTION_THRESH) {
          if(!Path.matchIntersect(intersect, feature.id, end.id).some((i) => Path.dist(i.point, endPoint) < TRAIL_INTERSECTION_THRESH)) {
            intersect.push({
              point: endPoint,
              trail0Id: feature.id,
              trail1Id: end.id
            });
          }
        }
      }
    });

    return intersect;
  }

  // recursive route finding step
  private static findRouteStep(start: TrailPoint, end: TrailPoint, intersects: Intersection[], features: FeatureEntrySet, depth: number): [number, number][] {
    // base case: same trail
    if(start.trail.id === end.trail.id) {
      return this.routeOnTrail(start, end);
    }
    // if we reached max search depth, terminate
    if(depth === 0) {
      return undefined;
    }
    // otherwise: look for route
    let routes: [number, number][][] = [];
    // follow all intersections
    const [jcts, jctsRemain] = Path.splitIntersects(intersects, start.trail.id);
    for(let i = 0; i < jcts.length; i++) {
      const jct = jcts[i];
      // route along current trail to junction
      const jctPt = {pt: jct.point, trail: start.trail};
      const route = this.routeOnTrail(start, jctPt);
      // select other trail in junction to follow
      const nextTrailId = jct.trail0Id === start.trail.id ? jct.trail1Id : jct.trail0Id;
      const nextStart = {pt: jct.point, trail: features.findTrail(nextTrailId)};
      // search from next junction
      const nextRoute = this.findRouteStep(nextStart, end, jctsRemain, features, depth - 1);
      if(nextRoute !== undefined) {
        routes.push(route.concat(nextRoute));
      }
    };
    // choose shortest route
    if(routes.length > 0) {
      let minDist = routeLengthMiles(routes[0]);
      let minDistI = 0;
      for(let i = 1; i < routes.length; i++) {
        const dist = routeLengthMiles(routes[i]);
        if(dist < minDist) {
          minDist = dist;
          minDistI = i;
        }
      }

      return routes[minDistI];
    }
    return undefined;
  }

  // find the shortest route between points
  private static findRoute(start: TrailPoint, end: TrailPoint, features: FeatureEntrySet): [number, number][] {
    const route: [number, number][] = [];

    // quick case: start and end are on the same trail
    if(start.trail.id === end.trail.id) {
      console.log("SAME TRAIL");
      return this.routeOnTrail(start, end);
    }

    // not the same trail, so we need to do route finding
    // find all trail intersections
    const intersect = Path.findTrailIntersections(features);

    return Path.findRouteStep(start, end, intersect, features, ROUTE_FINDING_DEPTH);
  }

  // add a new point to the path
  addPoint(point: PathPoint, features: FeatureEntrySet, distThreshold: number) {
    // if this is a straight line path, simply add the point to route
    if(!point.followFeatures) {
      this.points.push(point);
      this.route.push(point.coord);
    }
    // otherwise, find the shortest path along features
    else {
      // if this is the first point, put it at the nearest trail
      if(this.points.length === 0) {
        const trailPoint = Path.nearestPoint(point.coord, features, distThreshold);
        this.points.push({coord: trailPoint.pt, followFeatures: true});
        this.route.push(trailPoint.pt);
      }
      // otherwise, attempt to follow trails from previous point
      else {
        // previous point
        const prevPoint = this.points[this.points.length - 1];
        // get closest trail point to previous
        const startPoint = Path.nearestPoint(prevPoint.coord, features, undefined);
        // get ending point
        const endPoint = Path.nearestPoint(point.coord, features, distThreshold);
        // if ending point is not on trail, don't find route
        if(endPoint.trail === undefined) {
          this.points.push({coord: endPoint.pt, followFeatures: true});
          this.route.push(endPoint.pt);
          return;
        }
        // both start and end are on a trail, find a route between them
        const shortRoute = Path.findRoute(startPoint, endPoint, features);
        // if we didn't find a route, use straight line
        if(shortRoute === undefined) {
          this.points.push({coord: endPoint.pt, followFeatures: true});
          this.route.push(endPoint.pt);
          return;
        }
        // otherwise, add the found route
        if(!Path.pointsEqual(prevPoint.coord, startPoint.pt)) {
          this.route.push(startPoint.pt);
        }

        shortRoute.forEach((pt) => this.route.push(pt));

        this.points.push({coord: endPoint.pt, followFeatures: true});
        this.route.push(endPoint.pt);
      }
    }
  }

  // remove the last point on the path
  popPoint(): PathPoint {
    const pt = this.points.pop();
    // find the last remaining point on the path and remove from the route until we hit it
    if(this.points.length === 0) {
      this.route = [];
    } else {
      const last_pt = this.points[this.points.length - 1].coord;
      for(let i = this.route.length-1; i >= 0; i--) {
        if(this.route[i][0] === last_pt[0] && this.route[i][1] === last_pt[1]) {
          break;
        }

        this.route.pop();
      }
    }

    return pt;
  }
}

// a style of drawing a route (ie, road, trail, etc)
abstract class RouteStyle {
  abstract drawRoute(
    route: Route,
    ctx: CanvasRenderingContext2D,
    innerRadius: number,
    outerRadius: number,
    active: boolean,
    lonLatToCanvas: (cord: [number, number]) => [number, number]
  ): void;

  drawLines(
    route: Route,
    ctx: CanvasRenderingContext2D,
    lonLatToCanvas: (cord: [number, number]) => [number, number]
  ) {
    if(route.length > 0) {
      ctx.beginPath();
      ctx.moveTo(...lonLatToCanvas(route[0]));
      for (let i = 1; i < route.length; i++) {
        ctx.lineTo(...lonLatToCanvas(route[i]));
      }
      ctx.stroke();
    }
  }
}

class PathStyle extends RouteStyle {
  color: string;

  constructor(color: string) {
    super();
    this.color = color;
  }

  drawRoute(
    route: Route,
    ctx: CanvasRenderingContext2D,
    innerRadius: number,
    outerRadius: number,
    active: boolean,
    lonLatToCanvas: (cord: [number, number]) => [number, number]
  ): void {
    ctx.lineWidth = outerRadius;
    ctx.strokeStyle = this.color;
    ctx.setLineDash([]);
    this.drawLines(route, ctx, lonLatToCanvas);
  }
}

class TrailStyle extends RouteStyle {
  colors: [[string, string], [string, string]];
  dashDist: number;
  spaceDist: number;

  constructor(colors: [[string, string], [string, string]]) {
    super();
    this.colors = colors;
    this.dashDist = 8;
    this.spaceDist = 4;
  };

  drawRoute(
    route: Route,
    ctx: CanvasRenderingContext2D,
    innerRadius: number,
    outerRadius: number,
    active: boolean,
    lonLatToCanvas: (cord: [number, number]) => [number, number]
  ): void {
    ctx.lineWidth = outerRadius;
    ctx.strokeStyle = this.colors[active ? 1:0][1];
    ctx.setLineDash([]);
    this.drawLines(route, ctx, lonLatToCanvas);
    ctx.lineWidth = innerRadius;
    ctx.strokeStyle = this.colors[active ? 1:0][0];
    ctx.setLineDash([this.dashDist, this.spaceDist]);
    this.drawLines(route, ctx, lonLatToCanvas);
    ctx.setLineDash([]);

    let [x,y] = lonLatToCanvas(route[0]);
    ctx.fillStyle = "#ff0000";
    ctx.strokeStyle = "#ff0000";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, 2*Math.PI);
    ctx.stroke();
    ctx.fill();

    [x,y] = lonLatToCanvas(route[route.length - 1]);
    ctx.fillStyle = "#ff0000";
    ctx.strokeStyle = "#ff0000";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, 2*Math.PI);
    ctx.stroke();
    ctx.fill();
  }
}

// delay (in ms) to wait for scrolling to stop before loading tiles
const SCROLL_LOAD_DELAY = 350;
// delay (in ms) to wait for scrolling or moving to stop before loading features
const FEATURE_LOAD_DELAY = 350;

// lowest zoom to start loading features at
const MIN_FEATURE_ZOOM = 12;

interface MapAppOptions {
  trailWidthCoeff: number;
  trailColors: [[string, string], [string, string]];
  zoomCoeff: number;
}

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

enum AppMode {
  Normal,
  Measure
}

class MapApp {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;

  mode: AppMode;

  view: Viewport;
  declination: number;
  loadFeaturesCallbackId: number | null;

  // maps to display
  layers: MapLayerTiles[];

  // tiles for which features are loaded
  tileFeaturesLoaded: Set<number>;

  // features loaded
  features: FeatureEntrySet;
  featureDB: FeatureDatabase;

  // currently selected feature
  activeFeatureId: number;
  // path currently being constructed
  currentPath: Path;

  // should the longitude / latitude marks + scale be displayed
  showDecorators: boolean;

  // main boundary/margin size (pixels)
  margin: [[number, number], [number, number]];

  // mouse movements
  pMouseX: number;
  pMouseY: number;
  mouseClicked: boolean;
  mouseMoved: boolean;

  // scroll throttling
  wheelCallbackId: number | null;

  callbackId: number | null;

  options: MapAppOptions;
  trailStyle: RouteStyle;
  pathStyle: RouteStyle;

  constructor(canvas: HTMLCanvasElement, layers: MapLayer[], showDecorators: boolean, options: MapAppOptions, view: Viewport) {
    this.canvas = canvas;
    this.ctx = this.canvas.getContext('2d')!;
    this.width = this.canvas.width;
    this.height = this.canvas.height;

    this.mode = AppMode.Normal;
    this.currentPath = new Path();

    this.mouseClicked = false;
    this.pMouseX = 0;
    this.pMouseY = 0;
    this.mouseMoved = false;
    this.callbackId = null;
    this.wheelCallbackId = null;
    this.canvas.addEventListener('mousedown', (e: MouseEvent) => { this.mousedown(e); });
    this.canvas.addEventListener('mouseup', (e: MouseEvent) => { this.mouseup(e); });
    this.canvas.addEventListener('mouseleave', (e: MouseEvent) => { this.mouseup(e); });
    this.canvas.addEventListener('mousemove', (e: MouseEvent) => { this.mousemove(e); });
    this.canvas.addEventListener('wheel', (e: WheelEvent) => { this.wheel(e); });
    this.canvas.addEventListener('click', (e: MouseEvent) => this.mouseclick(e));
    window.addEventListener('keydown', (e: KeyboardEvent) => this.keydown(e));

    this.margin = showDecorators ? MARGINS : [[0, 0], [0, 0]];
    this.showDecorators = showDecorators;

    this.tileFeaturesLoaded = new Set();
    this.featureDB = new FeatureDatabase();
    this.featureDB.clear();
    this.activeFeatureId = -1;

    this.features = new FeatureEntrySet();

    this.view = view;
    this.declination = 0.0;
    this.loadFeaturesCallbackId = null;
    this.layers = [];
    this.options = options;
    this.trailStyle = new TrailStyle(this.options.trailColors);
    this.pathStyle = new PathStyle("#0000ff");
    this.setLayers(layers);
  }

  setMargins(showMargins: boolean) {
    this.margin = showMargins ? MARGINS : [[0, 0], [0, 0]];
  }

  setOptions(options: MapAppOptions) {
    this.options = options;
  }

  setLayers(layers: MapLayer[]) {
    this.layers = layers.map((layer) => {
      const canvas = document.createElement("canvas");
      canvas.width = this.viewSize()[0];
      canvas.height = this.viewSize()[1];
      return {
        ...layer,
        canvas,
        ctx: canvas.getContext("2d")!,
        tiles: new TileSetBuffer(
          layer.url,
          () => {
            if (this.callbackId == null) {
              this.callbackId = window.requestAnimationFrame(() => { this.run(); });
            }
          }
        )
      };
    });

    this.loadTiles();
  }

  mousedown(e: MouseEvent) {
    this.mouseMoved = false;
    this.mouseClicked = true;
    this.pMouseX = e.offsetX;
    this.pMouseY = e.offsetY;
  }

  mouseup(e: MouseEvent) {
    this.mouseClicked = false;
  }

  mouseclick(e: MouseEvent) {
    // if mouse was not moved (the user clicked on the map),
    // look for features to select
    if(!this.mouseMoved) {
      if(this.mode == AppMode.Normal) {
        this.clickFeature(e);
      } else if(this.mode == AppMode.Measure) {
        this.clickMeasure(e);
      }
    }
  }

  keydown(e: KeyboardEvent) {
    // switch to normal mode
    if(e.key == 'n') {
      this.mode = AppMode.Normal;
      this.activeFeatureId = -1;
      this.run();
    } 
    // switch to measure mode
    else if(e.key == 'm') {
      if(this.mode === AppMode.Normal) {
        this.currentPath = new Path();
      }
      this.mode = AppMode.Measure;
      this.activeFeatureId = -1;
      this.run();
    }
    // delete point
    else if(e.key == 'd' && this.mode === AppMode.Measure) {
      this.currentPath.popPoint();
      this.run();
    }
    // toggle decorators
    else if(e.key == 'f') {
      this.setShowDecorators(!this.showDecorators);
      this.run();
    }
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
    if (!this.mouseClicked) {
      return;
    }

    this.mouseMoved = true;

    const [w, h] = this.viewSize();
    this.view.pan(-(e.offsetX - this.pMouseX) / w, -(e.offsetY - this.pMouseY) / h);
    this.loadTiles();
    this.run();
    this.pMouseX = e.offsetX;
    this.pMouseY = e.offsetY;
  }

  wheel(e: WheelEvent) {
    const [x, y] = this.mousePos(e.offsetX, e.offsetY);
    this.view.zoom(e.deltaY * 0.005 * this.options.zoomCoeff, x, y);

    // set tile loading to occur SCROLL_LOAD_DELAY after scrolling stops
    if (this.wheelCallbackId != null) {
      window.clearTimeout(this.wheelCallbackId);
    }
    this.wheelCallbackId = window.setTimeout(() => { this.loadTiles(); }, SCROLL_LOAD_DELAY);

    this.run();
  }

  // get mouse position as coordinate
  private getMouseCoordinate(e: MouseEvent): [number, number] {
    const pos = this.mousePos(e.pageX, e.pageY);
    return this.view.getCoordinate(...pos);
  }

  // get current zoom level
  private getZoom(): number {
    return this.view.tileZoomLevel(...this.viewSize(), 256);
  }

  // get distance threshold for click to be considered on feature
  private clickDistanceThreshold(): number {
    return 0.0003 * Math.pow(2.0, 16 - this.getZoom());
  }

  // check if a feature was clicked and select it if so
  private clickFeature(e: MouseEvent) {
    const coord = this.getMouseCoordinate(e);
    const [feature, dist] = this.features.closestFeature(coord);

    if(dist < this.clickDistanceThreshold()) {
      this.activeFeatureId = feature.id;
      //alert(feature.name);
    } else {
      this.activeFeatureId = -1;
    }
    this.run();
  }

  // handle a click in measure mode
  private clickMeasure(e: MouseEvent) {
    const coord = this.getMouseCoordinate(e);

    this.currentPath.addPoint({coord, followFeatures: true}, this.features, 2.0 * this.clickDistanceThreshold());
    this.run();
  }

  // load features into database for current view
  private loadFeaturesDB() {
    // get the set of necessary tiles to load features for
    let tiles = this.view.coveredTiles(MAX_ZOOM_DATA_SPLIT);
    // remove any tiles already loaded
    this.tileFeaturesLoaded.forEach(tile => tiles.delete(tile));
    // load remaining tiles
    tiles.forEach((tile) => {
      this.featureDB.loadFromJSON(`dataset/${tile}.json`, () => {
        this.timeoutLoadNewFeatures();
      });
      this.tileFeaturesLoaded.add(tile);
    });
  }

  // find features in view and draw
  // this will not use any previously loaded features
  private runNewFeatures() {
    const zoom = this.getZoom();
    if (zoom >= MIN_FEATURE_ZOOM) {
      this.featureDB.featuresInView(this.view, new FeatureEntrySet()).then((features) => {
        this.features = features;
        this.run();
      });
    } else {
      this.features = new FeatureEntrySet();
      this.run();
    }
  }

  // load trails, features, and declination for the current viewport
  private loadFeatures() {
    // select features possibly in view from DB
    const zoom = this.getZoom();
    if (zoom >= MIN_FEATURE_ZOOM) {
      this.loadFeaturesDB();
      this.featureDB.featuresInView(this.view, this.features).then((features) => {
        this.features = features;
        this.run();
      });
    } else {
      this.features = new FeatureEntrySet();
      this.run();
    }
    // get declination
    getDeclination(this.view.centerLonLat()[0], this.view.centerLonLat()[1], (decl) => {
      this.declination = decl;
      this.run();
    });
  }

  private timeoutLoadFeatures() {
    if (this.loadFeaturesCallbackId !== null) {
      window.clearTimeout(this.loadFeaturesCallbackId);
    }
    this.loadFeaturesCallbackId = window.setTimeout(() => {
      this.loadFeatures();
    }, FEATURE_LOAD_DELAY);
  }

  private timeoutLoadNewFeatures() {
    if (this.loadFeaturesCallbackId !== null) {
      window.clearTimeout(this.loadFeaturesCallbackId);
    }
    this.loadFeaturesCallbackId = window.setTimeout(() => {
      this.runNewFeatures();
      //alert("Loading done");
    }, FEATURE_LOAD_DELAY);
  }

  private loadTiles() {
    for (let l = 0; l < this.layers.length; l++) {
      const zoom = this.getZoom();
      this.layers[l].tiles.loadNew(this.view, zoom);
    }
    this.timeoutLoadFeatures();
  }

  resize(w: number, h: number) {
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

    for (let i = start; i <= end; i += interval) {
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
      let writeLines = (lines: string[], x: number, y: number) => {
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
    } else {
      this.ctx.textAlign = "right";
    }
    this.ctx.fillText("MN", mNorthX, mNorthY);

    this.ctx.font = "14px sans-serif";
    this.ctx.textAlign = "left";
    this.ctx.textBaseline = "bottom";
    this.ctx.fillText(`${this.declination.toFixed(1)}°`, offX + declWidth / 2 + 5, offY + northHeight);
  }

  private clearMargins() {
    this.ctx.clearRect(0, 0, this.margin[0][0], this.height);
    this.ctx.clearRect(this.width - this.margin[0][1], 0, this.margin[0][1], this.height);

    this.ctx.clearRect(0, 0, this.width, this.margin[1][0]);
    this.ctx.clearRect(0, this.height - this.margin[1][1], this.width, this.margin[1][1]);
  }

  private lonLatToCanvasXY(c: [number, number]): [number, number] {
    const p = TileCoordinate.fromLonLat(c[0], c[1]).atZoom(0);
    return [this.xTileToCanvasPos(p[0]), this.yTileToCanvasPos(p[1])];
  }

  private getFeatureWidth(): [number, number] {
    const zoom = this.getZoom();
    const widths: [number, number] = zoom >= 18 ? [9, 4.5] :
      zoom >= 16 ? [5, 2] :
        zoom >= 15 ? [3, 2] :
          zoom >= 14 ? [2, 2] :
            [1.5, 1.5];
    
    return widths;
  }

  private drawFeatures() {
    const widths = this.getFeatureWidth();

    this.features.forEach((f) => {
      if (f.type === "trail") {
        this.trailStyle.drawRoute(
          f.route,
          this.ctx,
          widths[1] * this.options.trailWidthCoeff,
          widths[0] * this.options.trailWidthCoeff,
          f.id === this.activeFeatureId,
          (cord: [number, number]) => this.lonLatToCanvasXY(cord)
        );
      }
    });
  }

  private drawPath(path: Path) {
    const zoom = this.getZoom();
    const widths = this.getFeatureWidth();
    // draw route
    this.pathStyle.drawRoute(
      path.route, 
      this.ctx, 
      widths[1] * this.options.trailWidthCoeff,
      widths[0] * this.options.trailWidthCoeff,
      false,
      (cord: [number, number]) => this.lonLatToCanvasXY(cord)
    );
    // draw points on path
    const pointRadius = zoom <= 12 ? 1 : widths[1] * 2;

    path.points.forEach((p) => {
      const [x,y] = this.lonLatToCanvasXY(p.coord);
      this.ctx.fillStyle = "#ffffff";
      this.ctx.strokeStyle = "#000000";
      this.ctx.lineWidth = 3;
      this.ctx.beginPath();
      this.ctx.arc(x, y, pointRadius, 0, 2*Math.PI);
      this.ctx.stroke();
      this.ctx.fill();
    });
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
    this.drawFeatures();
    if(this.mode === AppMode.Measure) {
      this.drawPath(this.currentPath);
    }

    if (this.showDecorators) {
      this.clearMargins();
      this.drawLonLatLines();
      this.drawMapScales();
      this.drawMapDeclination(this.margin[0][0] + w - 80, this.margin[1][0] + h + 40);
    }
  }
}

const URLS = [
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}", // USGS Topo
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}.jpg", // ESRI Street Map
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}.jpg", // ESRI Topo
  "https://tile.openstreetmap.org/${z}/${x}/${y}.png", // OpenStreetMaps
  "https://caltopo.com/tile/fire_recent/{z}/{x}/{y}.png", // Fire History (caltopo)
  "https://caltopo.com/tile/hs_m315z45s3/{z}/{x}/{y}.png", // Shaded Relief (caltopo)
  "https://caltopo.com/tile/f16a/{z}/{x}/{y}.png", // USFS Topo (2016 green - caltopo)
  "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_FSTopo_01/MapServer/tile/{z}/{y}/{x}", // USFS Topo (white)
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}", // USGS Imagery
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}", // USGS Imagery Topo
  "https://caltopo.com/tile/n/{z}/{x}/{y}.png", // NAIP 2013-15 (caltopo)
  "	https://b-naturalatlas-tiles.global.ssl.fastly.net/imagery/{z}/{x}/{y}/t@2x.jpg", // natural atlas imagery
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png", // Mapzen Elevation Tile Service (decode: (red * 256 + green + blue / 256) - 32768)
];

let app: MapApp;

function resizeApp() {
  app.resize(window.innerWidth, window.innerHeight);
}

window.onload = function () {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);

  app = new MapApp(
    canvas,
    [
      { url: URLS[10], tileSize: 256, opacity: 1.0 },
    ],
    true,
    {
      trailWidthCoeff: 1.0,
      trailColors: [["#003300", "#00ff00"], ["#ff0000", "#ffaa00"]],
      zoomCoeff: 1.0
    },
    /*new Viewport(
      0.12700767108145705,
      0.30371974271087615,
      0.34833476697338744,
      0.4513438253895165
    )*/
    new Viewport(
      0.19162142582552674,
      0.37552084838990646,
      0.1928616347822477,
      0.376388858820732
    )
  );
  resizeApp();
};

window.onresize = function () {
  resizeApp();
}
