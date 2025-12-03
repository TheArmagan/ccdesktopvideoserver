const express = require("express");
const app = express();
const fs = require("fs");
const Jimp = require("jimp");
const stuffs = require("stuffs");
const chillout = require("chillout");
const nC = require("nearest-color");
const path = require("path");
const execAsync = require("util").promisify(require("child_process").exec);
const sharp = require("sharp");
const config = require("./config.json");

// Color keys for the 16 available slots (0-9, a-f)
const COLOR_KEYS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"];

let screenData = {};

/**
 * @returns {Buffer}
 */
async function screenToBuffer() {
  let filename = path.join(process.env.TEMP, `ccdvs-${Math.floor(Date.now() * Math.random())}.png`);
  await execAsync(`ScreenStuff.exe -f png -o ${filename} -i ${config.screenshot.scale} -s ${config.screenshot.screenIndex} ${config.screenshot.dither ? `-d ${config.screenshot.dither}` : ""} -t ${config.screenshot.threads}`);
  let buffer = await fs.promises.readFile(filename);
  fs.promises.unlink(filename)

  return buffer;
}

/**
 * Quantize colors by grouping similar colors together
 * @param {string} hex 
 * @param {number} factor - higher = more grouping
 * @returns {string}
 */
function quantizeColor(hex, factor = 16) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  const qr = Math.round(r / factor) * factor;
  const qg = Math.round(g / factor) * factor;
  const qb = Math.round(b / factor) * factor;

  return stuffs.rgbToHex(
    Math.min(255, Math.max(0, qr)),
    Math.min(255, Math.max(0, qg)),
    Math.min(255, Math.max(0, qb))
  );
}

/**
 * Compute the top 16 most used colors from an image
 * @param {Jimp} jimpImg 
 * @returns {{ palette: Object, colorMap: Object }} palette mapping color keys to hex, colorMap for nearest-color
 */
function computeTop16Colors(jimpImg) {
  const colorCounts = {};
  const colorSums = {}; // For computing average color in each quantized bucket

  // Count all colors (quantized for grouping)
  for (let y = 0; y < jimpImg.getHeight(); y++) {
    for (let x = 0; x < jimpImg.getWidth(); x++) {
      let { r, g, b } = stuffs.intToRgba(jimpImg.getPixelColor(x, y));
      let hex = stuffs.rgbToHex(r, g, b);
      let quantized = quantizeColor(hex, 24); // Group similar colors

      if (!colorCounts[quantized]) {
        colorCounts[quantized] = 0;
        colorSums[quantized] = { r: 0, g: 0, b: 0, count: 0 };
      }
      colorCounts[quantized]++;
      colorSums[quantized].r += r;
      colorSums[quantized].g += g;
      colorSums[quantized].b += b;
      colorSums[quantized].count++;
    }
  }

  // Sort colors by frequency and get top 16
  const top16Quantized = Object.entries(colorCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16)
    .map(([hex]) => hex);

  // Compute average color for each bucket to get the actual representative color
  const palette = {};
  const colorMap = {};

  top16Quantized.forEach((quantized, index) => {
    const sum = colorSums[quantized];
    const avgR = Math.round(sum.r / sum.count);
    const avgG = Math.round(sum.g / sum.count);
    const avgB = Math.round(sum.b / sum.count);
    const avgHex = stuffs.rgbToHex(avgR, avgG, avgB);

    const key = COLOR_KEYS[index];
    palette[key] = avgHex;
    colorMap[key] = avgHex;
  });

  // Fill remaining slots if less than 16 colors found
  while (Object.keys(palette).length < 16) {
    const index = Object.keys(palette).length;
    const key = COLOR_KEYS[index];
    palette[key] = "#000000";
    colorMap[key] = "#000000";
  }

  return { palette, colorMap };
}

let frameInterval = setInterval(async () => {
  let ss = await screenToBuffer();
  const resizedImg = await sharp(ss).resize(config.inGameScreens.totalWidth, config.inGameScreens.totalHeight, {
    fit: "fill"
  }).toBuffer();

  config.inGameScreens.screens.forEach(async (screen) => {
    let img = await sharp(resizedImg).extract({ left: screen.x, top: screen.y, width: screen.width, height: screen.height }).toBuffer();
    let jimpImg = await Jimp.read(img);

    // Compute the top 16 most used colors in this screen
    const { palette, colorMap } = computeTop16Colors(jimpImg);
    let nearestColor = nC.from(colorMap);

    let lastY = 0;
    let result = "";

    // First line is the palette data (16 hex colors separated by commas)
    result = COLOR_KEYS.map(key => palette[key]).join(",") + "\n";

    await chillout.repeat(jimpImg.getHeight(), async (y) => {
      if (lastY != y) {
        result += "\n";
        lastY = y;
      }
      await chillout.repeat(jimpImg.getWidth(), async (x) => {
        let { r, g, b } = stuffs.intToRgba(jimpImg.getPixelColor(x, y));
        let hex = stuffs.rgbToHex(r, g, b);
        result += nearestColor(hex).name;
      });
    });

    screenData[String(screen.id)] = result;
  })
}, 1000 / config.screenshot.frameRate)

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
app.listen(8000, () => {
  console.log(`| Listening on port 8000.\n`);
  config.inGameScreens.screens.forEach((screen) => {
    console.log(`| Screen ${screen.id} ready!`);
    console.log(`| wget run http://127.0.0.1:8000/code.lua?id=${screen.id}`);
  });

});

require("last-words")(async (isNode) => {
  if (isNode) return;
  console.log("\n| Stopping frame renderer..")
  clearInterval(frameInterval);
  await stuffs.sleep(100);
  clearTempFrames();
  console.log("| Exiting goodbye..")
  process.exit(0);
})

function clearTempFrames() {
  console.log("| Clearing temp frames..")
  let files = fs.readdirSync(process.env.TEMP).filter(i => i.endsWith("png"));
  files.forEach(file => {
    file = path.resolve(process.env.TEMP, file);
  });
  console.log(`| Cleared ${files.length} temp frames..`)
}

clearTempFrames();