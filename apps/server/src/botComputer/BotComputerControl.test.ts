import { describe, expect, it } from "vite-plus/test";

import {
  decodeScreenshotBase64,
  makeClickCommand,
  makePressCommand,
  makeScrollCommand,
  makeTypeCommand,
} from "./BotComputerControl.ts";

describe("Bot computer control commands", () => {
  it("keeps literal user text in one argv value after the option terminator", () => {
    const text = "hello; $(touch /tmp/nope) --help\nnext";
    expect(makeTypeCommand({ text })).toEqual([
      "xdotool",
      "type",
      "--clearmodifiers",
      "--delay",
      "1",
      "--",
      text,
    ]);
  });

  it("constructs fixed xdotool argument arrays", () => {
    expect(makeClickCommand({ x: 42, y: 77, button: "right" })).toEqual([
      "xdotool",
      "mousemove",
      "--sync",
      "42",
      "77",
      "click",
      "3",
    ]);
    expect(makePressCommand({ key: "ctrl+l" })).toEqual([
      "xdotool",
      "key",
      "--clearmodifiers",
      "--",
      "ctrl+l",
    ]);
    expect(makeScrollCommand({ direction: "down", amount: 3 })).toEqual([
      "xdotool",
      "click",
      "--repeat",
      "3",
      "5",
    ]);
  });

  it("accepts only bounded PNG-shaped base64", () => {
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(1440, 16);
    png.writeUInt32BE(900, 20);
    const encoded = png.toString("base64");

    expect(decodeScreenshotBase64(encoded)).toEqual({ data: encoded, width: 1440, height: 900 });
    expect(decodeScreenshotBase64("not base64")).toBeNull();
  });
});
