const express = require("express");
const app = express();
const fs = require("fs");
const Jimp = require("jimp");
const stuffs = require("stuffs");
const chillout = require("chillout");
const nC = require("nearest-color");
const path = require("path");
const execAsync = require("util").promisify(require("child_process").exec);
const { spawn } = require("child_process");
const sharp = require("sharp");
const config = require("./config.json");

// Audio capture state
let audioProcess = null;
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHUNK_SIZE = config.audio?.bufferSize || 4096;

// Ring buffer for multi-reader audio streaming
// Keeps ~0.5 seconds of audio for low latency, clients track their own read position
const AUDIO_RING_SIZE = Math.floor(AUDIO_SAMPLE_RATE * 0.5); // 0.5 seconds @ 48kHz
let audioRingBuffer = Buffer.alloc(AUDIO_RING_SIZE);
let audioWritePos = 0;      // Where new audio is written
let audioSequence = 0;      // Increments with each sample written (global position)

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
  if (!config.screenshot.enabled) {
    return;
  }

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

app.get("/video.lua", async (req, res) => {
  let data = await fs.promises.readFile(__dirname + "/video.lua", "utf8")
  res.type("text/plain");
  data = data.replace(/\{\{id\}\}/g, req.query.id || "1");
  data = data.replace(/\{\{base\}\}/g, req.query.base || `http://${req.headers.host}`);
  data = data.replace(/\{\{direction\}\}/g, req.query.direction || "right");
  res.send(data);
});

app.get("/audio.lua", async (req, res) => {
  let data = await fs.promises.readFile(__dirname + "/audio.lua", "utf8")
  res.type("text/plain");
  data = data.replace(/\{\{base\}\}/g, req.query.base || `http://${req.headers.host}`);
  data = data.replace(/\{\{direction\}\}/g, req.query.direction || "left");
  res.send(data);
});

// Audio capture using FFmpeg with WASAPI loopback (Windows desktop audio)
function startAudioCapture() {
  if (!config.audio?.enabled) {
    console.log("| Audio capture disabled in config");
    return;
  }

  console.log("| Starting audio capture...");

  // First try to list audio devices
  listAudioDevices().then(devices => {
    let audioDevice = config.audio?.device || "default";

    if (audioDevice === "default" && devices.length > 0) {
      // Try to find a loopback/stereo mix device
      const loopbackDevice = devices.find(d =>
        d.toLowerCase().includes("stereo mix") ||
        d.toLowerCase().includes("loopback") ||
        d.toLowerCase().includes("what u hear") ||
        d.toLowerCase().includes("wave out")
      );
      audioDevice = loopbackDevice || devices[0];
    }

    console.log(`| Using audio device: ${audioDevice}`);

    const args = [
      "-f", "dshow",
      "-audio_buffer_size", "20",
      "-i", `audio=${audioDevice}`,
      "-ac", "1",
      "-ar", "48000",
      "-acodec", "pcm_u8",
      "-f", "u8",
      "-"
    ];

    audioProcess = spawn("ffmpeg", args, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    audioProcess.stdout.on("data", (data) => {
      // Apply volume adjustment
      // Audio is unsigned 8-bit (0-255), centered at 128
      const volume = config.audio?.volume || 1.0;

      for (let i = 0; i < data.length; i++) {
        let sample = data[i];
        if (volume !== 1.0) {
          // Convert to signed (-128 to 127), apply volume, convert back to unsigned
          let signed = sample - 128;
          signed = Math.max(-128, Math.min(127, Math.round(signed * volume)));
          sample = signed + 128;
        }
        // Write to ring buffer
        audioRingBuffer[audioWritePos] = sample;
        audioWritePos = (audioWritePos + 1) % AUDIO_RING_SIZE;
        audioSequence++;
      }
    });

    audioProcess.stderr.on("data", (data) => {
      const msg = data.toString();
      if (!msg.includes("size=") && !msg.includes("time=")) {
        // Only log non-progress messages
        if (msg.includes("error") || msg.includes("Error")) {
          console.log(`| FFmpeg: ${msg.trim()}`);
        }
      }
    });

    audioProcess.on("error", (err) => {
      console.log(`| Audio capture error: ${err.message}`);
      console.log("| Make sure FFmpeg is installed and in PATH");
      console.log("| You may need to enable 'Stereo Mix' in Windows sound settings");
    });

    audioProcess.on("close", (code) => {
      if (code !== 0 && code !== null) {
        console.log(`| Audio capture stopped with code ${code}`);
      }
    });
  });
}

// List available audio devices using FFmpeg
async function listAudioDevices() {
  try {
    const { stderr } = await execAsync('ffmpeg -list_devices true -f dshow -i dummy 2>&1', { encoding: 'utf8' }).catch(e => ({ stderr: e.stderr || "" }));
    const lines = stderr.split('\n');
    const devices = [];
    let isAudioSection = false;

    for (const line of lines) {
      if (line.includes('DirectShow audio devices')) {
        isAudioSection = true;
        continue;
      }
      if (line.includes('DirectShow video devices')) {
        isAudioSection = false;
        continue;
      }
      if (isAudioSection) {
        const match = line.match(/"([^"]+)"/);
        if (match && !match[1].includes('@device')) {
          devices.push(match[1]);
        }
      }
    }

    console.log(`| Available audio devices: ${devices.join(", ") || "none found"}`);
    return devices;
  } catch (e) {
    console.log("| Could not list audio devices");
    return [];
  }
}

// Audio endpoint - returns PCM audio as comma-separated signed integers
// Supports multiple readers via sequence number tracking
// Client sends ?seq=N to get audio after sequence N, response includes new seq
app.get("/audio.pcm", (req, res) => {
  if (!config.audio?.enabled) {
    res.status(503).send("Audio disabled");
    return;
  }

  const chunkSize = parseInt(req.query.size) || AUDIO_CHUNK_SIZE;
  let clientSeq = parseInt(req.query.seq) || 0;

  // If client is too far behind (more than ring buffer size), jump to current
  if (clientSeq < audioSequence - AUDIO_RING_SIZE) {
    clientSeq = audioSequence - AUDIO_RING_SIZE + chunkSize;
  }

  // If client is ahead or at current position, no new data
  if (clientSeq >= audioSequence) {
    res.status(204).send();
    return;
  }

  // Calculate how many samples are available
  const available = audioSequence - clientSeq;
  const toRead = Math.min(available, chunkSize);

  if (toRead <= 0) {
    res.status(204).send();
    return;
  }

  // Calculate read position in ring buffer
  // clientSeq maps to a position in the ring buffer
  let readPos = (audioWritePos - (audioSequence - clientSeq) + AUDIO_RING_SIZE) % AUDIO_RING_SIZE;

  // Read samples from ring buffer
  const samples = [];
  for (let i = 0; i < toRead; i++) {
    const sample = audioRingBuffer[readPos] - 128; // Convert to signed
    samples.push(sample);
    readPos = (readPos + 1) % AUDIO_RING_SIZE;
  }

  const newSeq = clientSeq + toRead;

  res.type("text/plain");
  // First line is the new sequence number, second line is samples
  res.send(newSeq + "\n" + samples.join(","));
});

// Audio info endpoint
app.get("/audio/info", (req, res) => {
  res.json({
    enabled: config.audio?.enabled || false,
    sampleRate: AUDIO_SAMPLE_RATE,
    channels: 1,
    bitDepth: 8,
    signed: true,
    ringBufferSize: AUDIO_RING_SIZE,
    currentSequence: audioSequence,
    chunkSize: AUDIO_CHUNK_SIZE
  });
});


console.log(`| ComputerCraft Desktop Video Server by Kıraç Armağan Önal`);
app.listen(8000, () => {
  console.log(`| Listening on port 8000.\n`);

  // Video screens
  if (config.screenshot.enabled) {
    config.inGameScreens.screens.forEach((screen) => {
      console.log(`| Screen ${screen.id} ready!`);
      console.log(`|   Video: wget run http://127.0.0.1:8000/video.lua?id=${screen.id}`);
    });
    console.log(`|`);
  }

  // Audio
  if (config.audio?.enabled) {
    console.log(`| Audio ready!`);
    console.log(`|   Audio: wget run http://127.0.0.1:8000/audio.lua`);
    startAudioCapture();
  }

  console.log(`|`);
  console.log(`| Run game.lua on a computer with a monitor for video`);
  console.log(`| Run audio.lua on a separate computer with a speaker for audio`);
});

require("last-words")(async (isNode) => {
  if (isNode) return;
  console.log("\n| Stopping frame renderer..")
  clearInterval(frameInterval);

  // Stop audio capture
  if (audioProcess) {
    console.log("| Stopping audio capture..");
    audioProcess.kill();
    audioProcess = null;
  }

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