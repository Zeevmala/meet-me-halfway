import { describe, it, expect } from "vitest";
import { detectInAppBrowser, buildOpenInBrowserLink } from "./in-app-browser";

// Sample UAs gathered from real devices. Not exhaustive — just enough to
// catch the common in-app browsers we care about for the join-bug fix.
const SAMPLE_UAS = {
  whatsappAndroid:
    "Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36 WhatsApp/2.24.5.78 A",
  whatsappIOS:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WhatsApp/24.1.79",
  instagramIOS:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 311.0.0.30.118 (iPhone14,2; iOS 17_1; en_US; en-US; scale=3.00; 1170x2532; 547321908)",
  instagramAndroid:
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Instagram 311.0.0.30.118 Android (33/13; 420dpi; 1080x2400; Google/google; Pixel 7; panther; panther; en_US; 547321908)",
  facebookIOS:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/443.0.0.32.117;FBBV/567456789;FBDV/iPhone14,2;FBMD/iPhone;FBSN/iOS;FBSV/17.2;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]",
  facebookAndroid:
    "Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/445.0.0.36.118;]",
  messengerAndroid:
    "Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/445.0.0.36.118;] Messenger/445.0.0.36.118",
  twitterAndroid:
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 TwitterAndroid",
  tiktokIOS:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_2024.1.1 JsSdk/2.0 NetType/WIFI BytedanceWebview/d8a21c6",
  lineAndroid:
    "Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36 Line/14.1.0",
  telegramAndroid:
    "Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36 TelegramBot (like TwitterBot)",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  safariIOS:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
  desktopChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

describe("detectInAppBrowser", () => {
  it("detects WhatsApp on Android and iOS", () => {
    expect(detectInAppBrowser(SAMPLE_UAS.whatsappAndroid)).toBe("whatsapp");
    expect(detectInAppBrowser(SAMPLE_UAS.whatsappIOS)).toBe("whatsapp");
  });

  it("detects Instagram on Android and iOS", () => {
    expect(detectInAppBrowser(SAMPLE_UAS.instagramIOS)).toBe("instagram");
    expect(detectInAppBrowser(SAMPLE_UAS.instagramAndroid)).toBe("instagram");
  });

  it("detects Facebook on iOS and Android", () => {
    expect(detectInAppBrowser(SAMPLE_UAS.facebookIOS)).toBe("facebook");
    expect(detectInAppBrowser(SAMPLE_UAS.facebookAndroid)).toBe("facebook");
  });

  it("detects Messenger (more specific than Facebook)", () => {
    expect(detectInAppBrowser(SAMPLE_UAS.messengerAndroid)).toBe("messenger");
  });

  it("detects Twitter", () => {
    expect(detectInAppBrowser(SAMPLE_UAS.twitterAndroid)).toBe("twitter");
  });

  it("detects TikTok", () => {
    expect(detectInAppBrowser(SAMPLE_UAS.tiktokIOS)).toBe("tiktok");
  });

  it("detects Line", () => {
    expect(detectInAppBrowser(SAMPLE_UAS.lineAndroid)).toBe("line");
  });

  it("detects Telegram", () => {
    expect(detectInAppBrowser(SAMPLE_UAS.telegramAndroid)).toBe("telegram");
  });

  it("returns null for regular Chrome on Android", () => {
    expect(detectInAppBrowser(SAMPLE_UAS.chromeAndroid)).toBeNull();
  });

  it("returns null for regular Safari on iOS", () => {
    expect(detectInAppBrowser(SAMPLE_UAS.safariIOS)).toBeNull();
  });

  it("returns null for desktop Chrome", () => {
    expect(detectInAppBrowser(SAMPLE_UAS.desktopChrome)).toBeNull();
  });
});

describe("buildOpenInBrowserLink", () => {
  const originalUA = navigator.userAgent;
  const setUA = (ua: string) => {
    Object.defineProperty(navigator, "userAgent", {
      value: ua,
      configurable: true,
    });
  };
  const restore = () => {
    Object.defineProperty(navigator, "userAgent", {
      value: originalUA,
      configurable: true,
    });
  };

  it("rewrites https to x-safari-https on iOS", () => {
    setUA(SAMPLE_UAS.whatsappIOS);
    expect(buildOpenInBrowserLink("https://example.com/?code=ABC234")).toBe(
      "x-safari-https://example.com/?code=ABC234",
    );
    restore();
  });

  it("builds an intent:// link on Android", () => {
    setUA(SAMPLE_UAS.whatsappAndroid);
    const link = buildOpenInBrowserLink("https://example.com/foo?code=ABC234");
    expect(link).toBe(
      "intent://example.com/foo?code=ABC234#Intent;scheme=https;package=com.android.chrome;end",
    );
    restore();
  });

  it("returns the original URL on desktop", () => {
    setUA(SAMPLE_UAS.desktopChrome);
    const url = "https://example.com/?code=ABC234";
    expect(buildOpenInBrowserLink(url)).toBe(url);
    restore();
  });
});
