-- CC Desktop Audio Player
-- Streams desktop audio from the server to a CC:Tweaked speaker
-- Run this on a separate computer connected to a speaker

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

-- Smaller chunk size for smoother streaming (8KB)
local CHUNK_SIZE = 8192

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

while true do
  -- Request audio chunk from server (text format: comma-separated signed integers)
  local audioReq = http.get(BASE_URL .. "/audio.pcm?size=" .. CHUNK_SIZE)

  if audioReq then
    local statusCode = audioReq.getResponseCode()

    if statusCode == 200 then
      local data = audioReq.readAll()
      audioReq.close()

      if data and #data > 0 then
        -- Parse comma-separated signed integers
        local audioSamples = split(data, ",")

        if #audioSamples > 0 then
          -- Play audio through speaker
          -- speaker.playAudio returns false if buffer is full
          while not speaker_playAudio(audioSamples) do
            os.pullEvent("speaker_audio_empty")
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
    -- Request failed, wait before retry
    print("Connection failed, retrying...")
    sleep(0.5)
  end
end
