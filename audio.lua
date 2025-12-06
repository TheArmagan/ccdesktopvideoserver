-- CC Desktop Audio Player
-- Streams desktop audio from the server to a CC:Tweaked speaker
-- Run this on a separate computer connected to a speaker
-- Supports multiple speakers reading the same stream

local BASE_URL = "{{base}}"
local speaker = peripheral.wrap("{{direction}}")

if not speaker then
  print("Error: No speaker found!")
  print("Make sure a speaker is connected on the '" .. "{{direction}}" .. "' side")
  return
end

print("CC Desktop Audio Player")
print("Speaker found on {{direction}}")
print("Connecting to: " .. BASE_URL)
print("")

-- Cache speaker method
local speaker_playAudio = speaker.playAudio

-- Chunk size for streaming (4KB for lower latency)
local CHUNK_SIZE = 4096

-- Sequence number to track our position in the audio stream
local seq = 0

-- Connection state
local connected = false
local retryCount = 0
local MAX_RETRY_DELAY = 5

print("Starting audio stream...")
print("Press Ctrl+T to stop")
print("")

-- Helper to split string by delimiter
local function split(str, sep)
  local result = {}
  local pattern = "([^" .. sep .. "]+)"
  for match in string.gmatch(str, pattern) do
    result[#result + 1] = tonumber(match)
  end
  return result
end

-- Check if audio samples are silent (all samples below threshold)
-- Samples are signed (-128 to 127), so we check absolute value
local SILENCE_THRESHOLD = 3
local function isSilent(samples)
  local maxAbs = 0
  for i = 1, #samples do
    local abs = samples[i]
    if abs < 0 then abs = -abs end
    if abs > maxAbs then maxAbs = abs end
    -- Early exit if we find loud sample
    if maxAbs > SILENCE_THRESHOLD then return false end
  end
  return true
end

while true do
  -- Request audio chunk from server with our sequence position
  local ok, audioReq = pcall(http.get, BASE_URL .. "/audio.pcm?size=" .. CHUNK_SIZE .. "&seq=" .. seq)

  if ok and audioReq then
    local statusCode = audioReq.getResponseCode()

    if not connected then
      connected = true
      retryCount = 0
      print("Connected to server!")
    end

    if statusCode == 200 then
      local data = audioReq.readAll()
      audioReq.close()

      if data and #data > 0 then
        -- First line is new sequence number, second line is samples
        local newlinePos = string.find(data, "\n")
        if newlinePos then
          local newSeq = tonumber(string.sub(data, 1, newlinePos - 1))
          local samplesStr = string.sub(data, newlinePos + 1)

          if newSeq then
            seq = newSeq
          end

          -- Parse comma-separated signed integers
          local audioSamples = split(samplesStr, ",")

          if #audioSamples > 0 and not isSilent(audioSamples) then
            -- Play audio through speaker (skip if silent)
            -- speaker.playAudio returns false if buffer is full
            while not speaker_playAudio(audioSamples) do
              os.pullEvent("speaker_audio_empty")
            end
          end
        end
      end
    elseif statusCode == 204 then
      -- No audio available, wait a bit
      audioReq.close()
      sleep(0.05)
    elseif statusCode == 503 then
      audioReq.close()
      print("Audio is disabled on the server")
      sleep(1)
    else
      audioReq.close()
      sleep(0.1)
    end
  else
    -- Request failed, show status and retry with backoff
    if connected then
      connected = false
      print("Connection lost!")
    end
    retryCount = retryCount + 1
    local delay = math.min(retryCount * 0.5, MAX_RETRY_DELAY)
    print("Retrying in " .. delay .. "s... (attempt " .. retryCount .. ")")
    sleep(delay)
  end
end
