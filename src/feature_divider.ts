import { TrailEntry, decodeTile, tileContainingRoute, boundBoxForRoute, MAX_ZOOM_DATA_SPLIT, encodeTile, TileCoordinate } from "./util";
import * as fs from 'fs';
import oboe from 'oboe';

const src_path = process.argv[2];
const dst_path = process.argv[3];

let outStreams: {[key: number]: fs.WriteStream} = {};

oboe(fs.createReadStream(src_path))
  .node("trails.*", (data: TrailEntry) => {
    // bound all trail tiles to MAX_ZOOM_DATA_SPLIT
    let tileId = decodeTile(data.tile);
    if(tileId[0] > MAX_ZOOM_DATA_SPLIT) {
      const [x,y] = new TileCoordinate(...tileId).atZoom(MAX_ZOOM_DATA_SPLIT);
      tileId = [MAX_ZOOM_DATA_SPLIT, Math.floor(x), Math.floor(y)];
    }
    const tile = encodeTile(...tileId);

    // find or create the output json file for this tile
    let stream: fs.WriteStream;
    if(!(tile in outStreams)) {
      stream = fs.createWriteStream(`${dst_path}/${tile}.json`);
      // start the stream with an empty trail set
      stream.write('{"trails": [\n');
      outStreams[tile] = stream;
    } else {
      stream = outStreams[tile];

      stream.write(",\n");
    }

    // write the trail to the stream
    stream.write(`${JSON.stringify(data)}`);

    return oboe.drop;
  })
  .done(() => {
    // end all outputs
    for(let tile in outStreams) {
      outStreams[tile].write("\n]}\n");
      outStreams[tile].close();
    }
  })
  .fail((fail) => {
    console.log(fail);
  });