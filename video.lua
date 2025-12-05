-- CC Desktop Video Player
-- Streams desktop video from the server to a CC:Tweaked monitor
-- For audio, run audio.lua on a separate computer with a speaker

-- Localize frequently used functions for better performance
local string_gmatch = string.gmatch
local string_sub = string.sub
local string_rep = string.rep
local table_remove = table.remove
local tonumber = tonumber

-- Configuration
local BASE_URL = "{{base}}"

function split(inputString, separateWith)
    if separateWith == nil then
        separateWith = ", "
    end
    local t = {}
    for str in string_gmatch(inputString, "([^" .. separateWith .. "]+)") do
        t[#t + 1] = str
    end
    return t
end

-- Convert hex color string to RGB values (0-1 range)
local function hexToRGB(hex)
    local r = tonumber(string_sub(hex, 2, 3), 16) / 255
    local g = tonumber(string_sub(hex, 4, 5), 16) / 255
    local b = tonumber(string_sub(hex, 6, 7), 16) / 255
    return r, g, b
end

-- Color key to CC color mapping
local ccColors = {
    colors.white,     -- 0
    colors.orange,    -- 1
    colors.magenta,   -- 2
    colors.lightBlue, -- 3
    colors.yellow,    -- 4
    colors.lime,      -- 5
    colors.pink,      -- 6
    colors.gray,      -- 7
    colors.lightGray, -- 8
    colors.cyan,      -- 9
    colors.purple,    -- a
    colors.blue,      -- b
    colors.brown,     -- c
    colors.green,     -- d
    colors.red,       -- e
    colors.black      -- f
}

local m = peripheral.wrap("{{direction}}")
if not m then
    print("Error: No monitor found!")
    print("Make sure a monitor is connected on the '{{direction}}' side")
    return
end

m.setTextScale(0.5)

-- Cache monitor methods for faster access
local m_setPaletteColour = m.setPaletteColour
local m_setCursorPos = m.setCursorPos
local m_clear = m.clear
local m_blit = m.blit

local width, height = m.getSize()
print("CC Desktop Video Player")
print("Monitor: " .. width .. "x" .. height)
print("Connecting to: " .. BASE_URL)
print("")
print("For audio, run audio.lua on another computer")
print("Press Ctrl+T to stop")

local lastData = ""
local lastPalette = ""

-- Pre-compute "f" strings for common widths (cache)
local fCache = {}
local spaceCache = {}

while true do
    local infoReq = http.get(BASE_URL .. "/data.txt?id={{id}}")
    if infoReq ~= nil then
        local data = infoReq.readAll()
        infoReq.close()

        if lastData ~= data then
            lastData = data
            local lines = split(data, "\n")
            local lineCount = #lines

            -- First line contains the palette (16 hex colors separated by commas)
            if lineCount > 0 then
                local paletteLine = lines[1]

                -- Only update palette if it changed
                if lastPalette ~= paletteLine then
                    lastPalette = paletteLine
                    local paletteData = split(paletteLine, ",")

                    -- Set custom palette colors
                    for i = 1, 16 do
                        local hexColor = paletteData[i]
                        if hexColor then
                            local r, g, b = hexToRGB(hexColor)
                            m_setPaletteColour(ccColors[i], r, g, b)
                        end
                    end
                end

                -- Remove palette line from data
                table_remove(lines, 1)
                lineCount = lineCount - 1
            end

            m_setCursorPos(1, 1)
            m_clear()

            for lineIndex = 1, lineCount do
                local line = lines[lineIndex]
                local lineLen = #line

                -- Use cached strings or create and cache them
                local fStr = fCache[lineLen]
                local spaceStr = spaceCache[lineLen]

                if not fStr then
                    fStr = string_rep("f", lineLen)
                    spaceStr = string_rep(" ", lineLen)
                    fCache[lineLen] = fStr
                    spaceCache[lineLen] = spaceStr
                end

                m_setCursorPos(1, lineIndex)
                m_blit(spaceStr, fStr, line)
            end
        end
    end

    sleep(0.05)
end
