import { encodeTile, decodeTile } from "./util";

test('tile encoding', () => {
  // fuzz test tile encoding
  for(let i = 0; i < 5000; i++) {
    const z = Math.round(Math.random() * 15);
    const x = Math.floor(Math.random() * Math.pow(2, z));
    const y = Math.floor(Math.random() * Math.pow(2, z));
    const t = encodeTile(z, x, y);
    const [a, b, c] = decodeTile(t);
    expect(a).toEqual(z);
    expect(b).toEqual(x);
    expect(c).toEqual(y);
  }
});