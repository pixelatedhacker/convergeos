import type {
  BotComputerClickInput,
  BotComputerPressInput,
  BotComputerScrollInput,
  BotComputerTypeInput,
} from "@t3tools/contracts";

export const BOT_COMPUTER_SCREENSHOT_PATH = "/tmp/convergeos-bot-computer.png";
export const BOT_COMPUTER_MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
export const BOT_COMPUTER_MAX_SCREENSHOT_BASE64_BYTES =
  Math.ceil(BOT_COMPUTER_MAX_SCREENSHOT_BYTES / 3) * 4 + 4;

export const makeSnapshotCaptureCommand = (): ReadonlyArray<string> => [
  "scrot",
  "--overwrite",
  BOT_COMPUTER_SCREENSHOT_PATH,
];

export const makeSnapshotEncodeCommand = (): ReadonlyArray<string> => [
  "base64",
  "-w",
  "0",
  BOT_COMPUTER_SCREENSHOT_PATH,
];

export const makeSnapshotCleanupCommand = (): ReadonlyArray<string> => [
  "rm",
  "-f",
  BOT_COMPUTER_SCREENSHOT_PATH,
];

export const makeClickCommand = (input: BotComputerClickInput): ReadonlyArray<string> => [
  "xdotool",
  "mousemove",
  "--sync",
  String(input.x),
  String(input.y),
  "click",
  input.button === "left" ? "1" : input.button === "middle" ? "2" : "3",
];

export const makeTypeCommand = (input: BotComputerTypeInput): ReadonlyArray<string> => [
  "xdotool",
  "type",
  "--clearmodifiers",
  "--delay",
  "1",
  "--",
  input.text,
];

export const makePressCommand = (input: BotComputerPressInput): ReadonlyArray<string> => [
  "xdotool",
  "key",
  "--clearmodifiers",
  "--",
  input.key,
];

export const makeScrollCommand = (input: BotComputerScrollInput): ReadonlyArray<string> => [
  "xdotool",
  "click",
  "--repeat",
  String(input.amount),
  input.direction === "up"
    ? "4"
    : input.direction === "down"
      ? "5"
      : input.direction === "left"
        ? "6"
        : "7",
];

export function decodeScreenshotBase64(encoded: string): {
  readonly data: string;
  readonly width: number;
  readonly height: number;
} | null {
  const value = encoded.trim();
  if (value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const png = Buffer.from(value, "base64");
  if (png.byteLength > BOT_COMPUTER_MAX_SCREENSHOT_BYTES || png.byteLength < 24) return null;
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  if (png.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || width > 16_384 || height < 1 || height > 16_384) return null;
  return { data: value, width, height };
}
