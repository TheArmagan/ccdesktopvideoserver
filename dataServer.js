const express = require("express");
const app = express();
const fs = require("fs");
const Jimp = require("jimp");
const stuffs = require("stuffs");
const chillout = require("chillout");
const colorMap = require("./colorMap.json");
const nC = require("nearest-color");
const nearestColor = nC.from(colorMap);
const screenshot = require("screenshot-desktop");
const path = require("path");
const { screens, totalWidth, totalHeight } = require("./screens.json");
let screenData = {};


/**

 * @returns {Buffer}
 */
async function screenToBuffer() {
  let filename = `${process.env.TEMP}/ccdvs-${Math.floor(Date.now() * Math.random())}.png`;
  await screenshot({ filename, format: "png" });
  let buffer = await fs.promises.readFile(filename);
  fs.promises.unlink(filename)
  return buffer;
}


let frameInterval = setInterval(async () => {
  let ss = await screenToBuffer();
  let fullImg = await Jimp.create(ss);
  await fullImg.resize(totalWidth, totalHeight);

  screens.forEach(async (screen) => {
    let img = fullImg.clone().crop(screen.x, screen.y, screen.width, screen.height);
    let lastY = 0;
    let result = "";
    await chillout.repeat(img.getHeight(), async (y) => {
      if (lastY != y) {
        result += "\n";
      }
      await chillout.repeat(img.getWidth(), async (x) => {
        let { r, g, b } = stuffs.intToRgba(img.getPixelColor(x, y));
        let hex = stuffs.rgbToHex(r, g, b);
        result += nearestColor(hex).name;
      });
    });
    screenData[String(screen.id)] = result;
  })
}, 1000/5)

app.get("/data.txt", async (req, res) => {
  res.type("text/plain");
  res.send(screenData[req.query.id || "1"] || "");
});

app.get("/code.lua", async (req, res) => {
  let data = await fs.promises.readFile(__dirname + "/drawData.lua", "utf8")
  res.type("text/plain");
  data = data.replace("{{id}}", req.query.id || "1");
  data = data.replace("{{base}}", req.query.base || "http://127.0.0.1:5852")
  data = data.replace("{{direction}}", req.query.direction || "right")
  res.send(data);
});


console.log(`| ComputerCraft Desktop Video Server by Kıraç Armağan Önal`);
app.listen(5852, () => {
  console.log(`| Listening on port 5852.\n`);
  screens.forEach((screen) => {
    console.log(`| Screen ${screen.id} ready!`);
    console.log(`| wget run http://127.0.0.1:5852/code.lua?id=${screen.id}`);
  });

});

require("last-words")(async (isNode) => {
  if (isNode) return;
  console.log("\n| Stopping frame renderer..")
  clearInterval(frameInterval);
  await stuffs.sleep(100);
  console.log("| Clearing temp frames..")
  let files = fs.readdirSync(process.env.TEMP).filter(i => i.endsWith("png"));
  files.forEach(file => {
    file = path.resolve(process.env.TEMP, file);
  });
  console.log(`| Cleared ${files.length} temp frames..`)
  console.log("| Exiting goodbye..")
  process.exit(0);
})