import { TrailEntry, encodeTile, tileContainingRoute, boundBoxForRoute } from "./util";
import * as fs from 'fs';
import oboe from 'oboe';

// USFS trail feature entry (format from USFS National Trail System geojson)
interface USFSFeatureEntry {
  type: string;
  properties: {
    // Internal USFS ID
    OBJECTID: string;
    // Official trail number / identifier
    TRAIL_NO: string;
    // Official name
    TRAIL_NAME: string | null;
    // Surface type
    TRAIL_TYPE: "SNOW" | "WATER" | "TERRA";
    // Internal USFS control number
    TRAIL_CN: string;
    // Beginning measuring point on route for this segment
    BMP: number;
    // End measuring point on route for this segment
    EMP: number;
    // Segment length in miles
    SEGMENT_LENGTH: number;
    // FS admin unit code in which this segment is in
    ADMIN_ORG: string;
    // FS admin unit code responsible for this segment
    MANAGING_ORG: string;
    // unknown
    SECURITY_ID: string;
    // Which attributes are set for this segment
    ATTRIBUTESUBSET: "TRAILNFS_MGMT" | "TRAILNFS_CENTERLINE" | "TRAILNFS_BASIC";
    // If the trail is a designated national trail
    // 0 = no data
    // 1 = not a national trail
    // 2 = National Trail, not Scenic or Historic
    // 3 = National Trail, Scenic or Historic
    NATIONAL_TRAIL_DESIGNATION: 0 | 1 | 2 | 3;
    // Trail development level (1 = minimal, 2 = moderate, 3 = developed, 5 = fully developed)
    TRAIL_CLASS: "1" | "2" | "3" | "4" | "5" | "N" | null;
    // Trail accessibility
    ACCESSIBILITY_STATUS: "NOT ACCESSIBLE" | "ACCESSIBLE" | "N/A" | null;
    // Predominant surface type
    TRAIL_SURFACE: "IMPORTED COMPACTED MATERIAL" | "AC- ASPHALT" | "NAT - NATIVE MATERIAL" | "SNOW" | "N/A" | null;
    // Predominant surface firmness
    SURFACE_FIRMNESS: "VS - VERY SOFT" | "S - SOFT" | "P - PAVED" | "F - FIRM" | "H - HARD" | "N/A" | null;
    // Typical trail grade (percent)
    TYPICAL_TRAIL_GRADE: string | null;
    // Typical trail width (inches)
    TYPICAL_TREAD_WIDTH: string | null;
    // Min trail width (inches)
    MINIMUM_TRAIL_WIDTH: string | null;
    // Typical cross (sideways) slope (percent)
    TYPICAL_TREAD_CROSS_SLOPE: string | null;
    // If the segment is in or crosses and area with special management
    PECIAL_MGMT_AREA: "NM - NATIONAL MONUMENT" | "RNA - RESEARCH NATURAL AREA" | "WSR - SCENIC" | "WSA - WILD" | "NRA - NATIONAL RECREATION AREA" | "WSR - RECREATION" | "URA - UNROADED AREA" | "IRA - INVENTORIED ROADLESS AREA" | "SA - WILDERNESS STUDY AREA" | "N/A" | null;
    // Development scale (same as TRAIL_CLASS)
    TERRA_BASE_SYMBOLOGY: "TC1-2" | "TC3" | "TC4-5" | "N/A" | null;
    // Motor vehicle usage
    MVUM_SYMBOL: number | null;
    TERRA_MOTORIZED: string | null;
    SNOW_MOTORIZED: string | null;
    WATER_MOTORIZED: string | null;
    // Allowable land uses (concatenation of following values):
    // 1 = Hiker
    // 2 = Pack and saddle
    // 3 = bike
    // 4 = Motorcycle
    // 5 = ATV
    // 6 = 4WD>50"
    ALLOWED_TERRA_USE: string | null;
    // Allowable snow uses (concatenation of following values):
    // 1 = Snowshoe
    // 2 = Cross-country ski
    // 3 = Snowmobile
    ALLOWED_SNOW_USE: string | null;
    // Trail management dates for different uses (Managed, Acceptable/Discourages, Restricted)
    HIKER_PEDESTRIAN_MANAGED: string | null;
    HIKER_PEDESTRIAN_ACCPT_DISC: string | null;
    HIKER_PEDESTRIAN_RESTRICTED: string | null;
    PACK_SADDLE_MANAGED: string | null;
    PACK_SADDLE_ACCPT_DISC: string | null;
    PACK_SADDLE_RESTRICTED: string | null;
    BICYCLE_MANAGED: string | null;
    BICYCLE_ACCPT_DISC: string | null;
    BICYCLE_RESTRICTED: string | null;
    MOTORCYCLE_MANAGED: string | null;
    MOTORCYCLE_ACCPT_DISC: string | null;
    MOTORCYCLE_RESTRICTED: string | null;
    ATV_MANAGED: string | null;
    ATV_ACCPT_DISC: string | null;
    ATV_RESTRICTED: string | null;
    FOURWD_MANAGED: string | null;
    FOURWD_ACCPT_DISC: string | null;
    FOURWD_RESTRICTED: string | null;
    SNOWMOBILE_MANAGED: string | null;
    SNOWMOBILE_ACCPT_DISC: string | null;
    SNOWMOBILE_RESTRICTED: string | null;
    SNOWSHOE_MANAGED: string | null;
    SNOWSHOE_ACCPT_DISC: string | null;
    SNOWSHOE_RESTRICTED: string | null;
    XCOUNTRY_SKI_MANAGED: string | null;
    XCOUNTRY_SKI_ACCPT_DISC: string | null;
    XCOUNTRY_SKI_RESTRICTED: string | null;
    MOTOR_WATERCRAFT_MANAGED: string | null;
    MOTOR_WATERCRAFT_ACCPT_DISC: string | null;
    MOTOR_WATERCRAFT_RESTRICTED: string | null;
    NONMOTOR_WATERCRAFT_MANAGED: string | null;
    NONMOTOR_WATERCRAFT_ACCPT_DISC: string | null;
    NONMOTOR_WATERCRAFT_RESTRICTED: string | null;
    // Trail segment length in miles, as calculated from the GIS
    // may differ from SEGMENT_LENGTH, may be 0.0
    GIS_MILES: number;
    // Internal gis id
    GLOBALID: string;
  },
  geometry: {
    type: "LineString";
    // longitude, latitude coordinates (decimal degrees)
    coordinates: [number, number][];
  }
}

function USFSTrailToEntry(entry: USFSFeatureEntry, id: number): TrailEntry {
  const tile = tileContainingRoute(entry.geometry.coordinates);
  return {
    id,
    type: "trail",
    name: entry.properties.TRAIL_NAME ?? "Unnamed USFS Trail",
    length: entry.properties.SEGMENT_LENGTH,
    route: entry.geometry.coordinates,
    tile: encodeTile(...tile),
    boundBox: boundBoxForRoute(entry.geometry.coordinates),
  };
}


let id = 0;
console.log('{"trails": [');
oboe(fs.createReadStream("USFS_Trail_System.geojson"))
  .node("features.*", (data: USFSFeatureEntry) => {
    // TODO: handle geometry type MultiLineString (trails with splits in the middle)
    if(data.geometry === null || data.geometry.type !== "LineString") {
      return;
    }
    if(id != 0) {
      console.log(",\n");
    }
    const entry = USFSTrailToEntry(data, id++);
    console.log(`${JSON.stringify(entry)}`);

    return oboe.drop;
  })
  .done(() => {
    console.log("]}");
  });