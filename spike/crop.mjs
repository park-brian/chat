// A crop of a tall PNG, to look at: node spike/crop.mjs in.png top height [out.png] [scale]
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const [input, top = 0, height = 768, output = input.replace(/\.png$/, `.crop-${top}.png`), scale = 1] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage();
const url = "data:image/png;base64," + (await readFile(input)).toString("base64");
const out = await page.evaluate(async ([url, top, height, scale]) => {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = Object.assign(document.createElement("canvas"), { width: img.width * scale, height: height * scale });
  c.getContext("2d").drawImage(img, 0, top, img.width, height, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}, [url, +top, +height, +scale]);
await writeFile(output, Buffer.from(out.split(",")[1], "base64"));
console.log(output);
await browser.close();
