import { encodeTile, decodeTile, TileId, TileCoordinate, getLineCrossedTiles, tileContaining, boundBoxOverlap } from "./util";

function testTileEncoding() {
  // fuzz test tile encoding
  for(let i = 0; i < 50000; i++) {
    const z = Math.round(Math.random() * 15);
    const x = Math.floor(Math.random() * Math.pow(2, z));
    const y = Math.floor(Math.random() * Math.pow(2, z));
    const t = encodeTile(z, x, y);
    const [a, b, c] = decodeTile(t);
    console.assert(a === z);
    console.assert(b === x);
    console.assert(c === y);
  }
};

function arraysContainSame<T>(a: T[], b: T[], cmp: (a: T, b: T) => number): boolean {
  a = a.concat().sort(cmp);
  b = b.concat().sort(cmp);
  if(a.length !== b.length) {
    return false;
  }
  for(let i = 0; i < a.length; i++) {
    if(cmp(a[i], b[i]) !== 0) {
      return false;
    }
  }

  return true;
}

function cmpTileId(a: TileId, b: TileId): number {
  if(a[0] > b[0]) {
    return 1;
  } else if(a[0] < b[0]) {
    return -1;
  } else if(a[1] > b[1]) {
    return 1;
  } else if (a[1] < b[1]) {
    return -1;
  } else if(a[2] > b[2]) {
    return 1;
  } else if(a[2] < b[2]) {
    return -1;
  } else {
    return 0;
  }
}

function cmpNum(a: number, b: number): number {
  return a - b;
}

function testLineTileCross() {
  const a = new TileCoordinate(4, 0.5, 0.5);
  const b = new TileCoordinate(4, 2.5, 3.5);

  const hit0 = getLineCrossedTiles(a, b, 4);
  console.assert(
    arraysContainSame(
      hit0, 
      [[4, 0, 0], 
       [4, 0, 1],
       [4, 1, 1],
       [4, 1, 2],
       [4, 2, 2],
       [4, 2, 3]],
      cmpTileId
    )
  );

  const hit1 = getLineCrossedTiles(a, b, 3);
  console.assert(
    arraysContainSame(
      hit1, 
      [[3, 0, 0], 
       [3, 0, 1],
       [3, 1, 1]],
      cmpTileId
    )
  );

  const hit2 = getLineCrossedTiles(new TileCoordinate(12, 0.2, 0.15), new TileCoordinate(12, 0.34, 0.995), 12);
  console.assert(
    arraysContainSame(
      hit2, 
      [[12, 0, 0]],
      cmpTileId
    )
  );
}

function testTileContaining() {
  console.assert(arraysContainSame(
    tileContaining([
      [2, 1, 2],
      [3, 2, 4]
    ]),
    [2, 1, 2],
    cmpNum
  ));
  console.assert(arraysContainSame(
    tileContaining([
      [3, 4, 2],
      [3, 6, 1],
      [2, 3, 1],
      [3, 0, 7]
    ]),
    [0, 0, 0],
    cmpNum
  ));
  console.assert(arraysContainSame(
    tileContaining([
      [3, 4, 2],
      [3, 6, 1],
      [2, 3, 1]
    ]),
    [1, 1, 0],
    cmpNum
  ));
}

function testBBOverlap() {
  console.assert(
    boundBoxOverlap([[0, 0], [1, 1]], [[0.5, 0.5], [0.8, 0.8]])
  );
  console.assert(
    boundBoxOverlap([[0, 0], [1, 1]], [[-0.5, -0.5], [0.8, 0.8]])
  );
  console.assert(
    boundBoxOverlap([[0, 0], [1, 1]], [[-0.5, 0.5], [0.8, 0.8]])
  );
  console.assert(
    boundBoxOverlap([[0, 0], [1, 1]], [[0.5, -0.5], [0.8, 0.1]])
  );
  console.assert(
    !boundBoxOverlap([[0, 0], [1, 1]], [[-0.5, -0.5], [0.8, -0.1]])
  );

  console.assert(
    boundBoxOverlap([[0.5, 0.5], [0.8, 0.8]], [[0, 0], [1, 1]])
  );
  console.assert(
    boundBoxOverlap([[-0.5, -0.5], [0.8, 0.8]], [[0, 0], [1, 1]])
  );
  console.assert(
    boundBoxOverlap([[-0.5, 0.5], [0.8, 0.8]], [[0, 0], [1, 1]])
  );
  console.assert(
    boundBoxOverlap([[0.5, -0.5], [0.8, 0.1]], [[0, 0], [1, 1]])
  );
  console.assert(
    !boundBoxOverlap([[-0.5, -0.5], [0.8, -0.1]], [[0, 0], [1, 1]])
  );
}

testTileEncoding();
testLineTileCross();
testTileContaining();
testBBOverlap();
console.log("Tests done");