/* ==========================================================================
   Bigmix Studio
   --------------------------------------------------------------------------
   A conversational image editor that runs entirely in the browser.

   Pipeline for every turn:
     1. The attached File is read into a data URL (FileReader).
     2. The image is drawn onto an off-screen <canvas> at its native size.
     3. A deterministic, prompt-driven colour grade is applied with the
        Canvas 2D API, writing directly into an ImageData buffer.
     4. The canvas is exported as a JPEG data URL and appended to the
        assistant message.

   Nothing is uploaded. The previous result can be used as the source for the
   next round, so edits can continue indefinitely.
   ========================================================================== */

(function () {
  "use strict";

  /* ------------------------------------------------------------------------
     Configuration
     ------------------------------------------------------------------------ */

  var MAX_FILES = 8;
  var MAX_BYTES = 20 * 1024 * 1024;
  var MAX_PIXELS = 52 * 1000 * 1000;
  var MIN_SIDE = 24;
  var EXPORT_QUALITY = 0.92;
  var THUMBNAIL_SIZE = 120;
  var MIN_RENDER_MS = 820;
  var LONG_PROMPT = 132;

  var VIDEO_EXTENSIONS = ["mp4", "mov", "webm"];

  var MIME_TO_EXTENSION = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp"
  };

  var EXTENSION_TO_MIME = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp"
  };

  var SAMPLE = {
    key: "sample:window-light",
    name: "window-light.jpg",
    src: "./studio-sample.jpg",
    width: 928,
    height: 1152
  };

  var REDUCED_MOTION = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: false };

  /* ------------------------------------------------------------------------
     Style catalogue
     ------------------------------------------------------------------------
     These are the "models" behind the simulation. Each style owns a palette
     of prompt keywords, a deterministic pixel treatment and, optionally, a
     canvas-level finishing pass. The pixel treatment never moves, crops or
     retouches anything — it only remaps colour, contrast and light.
     ------------------------------------------------------------------------ */

  var STYLES = [
    {
      id: "warm-film",
      label: "Warm film",
      short: "Warm",
      blurb: "sun-warmed highlights, gold in the shadows, fine grain",
      keywords: {
        warm: 3,
        warmer: 3,
        warmth: 3,
        gold: 3,
        golden: 3,
        honey: 3,
        summer: 3,
        sunset: 3,
        "golden hour": 4,
        film: 2,
        "film grain": 3,
        vintage: 2,
        "old photo": 3,
        nostalgic: 2,
        cozy: 2,
        autumn: 2,
        amber: 2,
        sepia: 2
      },
      apply: function (api) {
        var data = api.imageData.data;
        var red = api.lut(
          [[0, 0.038], [0.18, 0.168], [0.52, 0.545], [0.84, 0.9], [1, 0.988]],
          { gain: 1.035, gamma: 0.985 }
        );
        var green = api.lut(
          [[0, 0.04], [0.18, 0.172], [0.52, 0.535], [0.84, 0.874], [1, 0.978]],
          { gain: 0.998 }
        );
        var blue = api.lut(
          [[0, 0.062], [0.18, 0.16], [0.52, 0.478], [0.84, 0.784], [1, 0.932]],
          { gain: 0.94, gamma: 1.015 }
        );

        for (var i = 0; i < data.length; i += 4) {
          data[i] = red[data[i]];
          data[i + 1] = green[data[i + 1]];
          data[i + 2] = blue[data[i + 2]];
          data[i + 3] = 255;
        }

        api.finish({
          grain: 0.05,
          vignette: 0.16,
          warmHighlights: 0.9,
          coolShadows: 0.25
        });
      },
      finish: function (api) {
        api.glow(18, 0.055);
      }
    },
    {
      id: "noir",
      label: "Noir",
      short: "Noir",
      blurb: "true monochrome, deep blacks, a silver highlight roll-off",
      keywords: {
        "black and white": 4,
        "black white": 3,
        monochrome: 4,
        noir: 4,
        grayscale: 4,
        greyscale: 4,
        bw: 3,
        "b w": 3,
        "b and w": 4,
        desaturate: 2,
        "no color": 3,
        silver: 2,
        contrast: 1,
        "high contrast": 2,
        dramatic: 2,
        moody: 1
      },
      apply: function (api) {
        var data = api.imageData.data;
        var tone = api.lut(
          [[0, 0], [0.1, 0.045], [0.45, 0.47], [0.8, 0.872], [1, 1]],
          { gamma: 1.03 }
        );

        for (var i = 0; i < data.length; i += 4) {
          var luminance = data[i] * 0.3 + data[i + 1] * 0.66 + data[i + 2] * 0.04;
          var value = tone[luminance <= 0 ? 0 : luminance >= 255 ? 255 : luminance | 0];
          data[i] = value;
          data[i + 1] = value;
          data[i + 2] = value;
          data[i + 3] = 255;
        }

        api.finish({ grain: 0.075, vignette: 0.22, coolShadows: 0.12 });
      },
      finish: function (api) {
        api.wash("rgb(255, 226, 190)", 0.05, "soft-light");
      }
    },
    {
      id: "cyanotype",
      label: "Cyanotype",
      short: "Cyan",
      blurb: "mineral blues, paper-white highlights, a sun-print calm",
      keywords: {
        cyanotype: 5,
        cyan: 4,
        blueprint: 4,
        "blue print": 3,
        "ice blue": 3,
        "blue evening": 4,
        "evening blue": 4,
        "quiet blue": 3,
        arctic: 3,
        glacial: 3,
        "cool blue": 3,
        cold: 2,
        cool: 2,
        blue: 2,
        winter: 2,
        steel: 2,
        teal: 2,
        ocean: 2
      },
      apply: function (api) {
        var data = api.imageData.data;
        var tone = api.lut(
          [[0, 0.02], [0.2, 0.17], [0.55, 0.6], [0.86, 0.92], [1, 0.995]],
          { gamma: 0.98 }
        );
        var shadow = [9, 26, 48];
        var highlight = [216, 236, 247];

        for (var i = 0; i < data.length; i += 4) {
          var luminance = data[i] * 0.28 + data[i + 1] * 0.68 + data[i + 2] * 0.04;
          var value = tone[luminance <= 0 ? 0 : luminance >= 255 ? 255 : luminance | 0] / 255;
          data[i] = shadow[0] + (highlight[0] - shadow[0]) * value;
          data[i + 1] = shadow[1] + (highlight[1] - shadow[1]) * value;
          data[i + 2] = shadow[2] + (highlight[2] - shadow[2]) * value;
          data[i + 3] = 255;
        }

        api.finish({
          grain: 0.055,
          vignette: 0.16,
          coolHighlights: 0.55,
          coolShadows: 0.45
        });
      },
      finish: function (api) {
        api.wash("rgb(40, 96, 140)", 0.05, "overlay");
      }
    },
    {
      id: "amber-dusk",
      label: "Amber dusk",
      short: "Dusk",
      blurb: "low evening sun, copper highlights, softened edges",
      keywords: {
        amber: 4,
        dusk: 4,
        evening: 4,
        "evening light": 4,
        "low sun": 4,
        ember: 3,
        candle: 3,
        orange: 3,
        burnt: 3,
        terracotta: 3,
        copper: 2,
        sunset: 2,
        warm: 1
      },
      apply: function (api) {
        var data = api.imageData.data;
        var red = api.lut(
          [[0, 0.055], [0.2, 0.185], [0.55, 0.57], [0.85, 0.91], [1, 0.99]],
          { gain: 1.02 }
        );
        var green = api.lut(
          [[0, 0.04], [0.2, 0.16], [0.55, 0.5], [0.85, 0.83], [1, 0.95]],
          { gain: 0.965 }
        );
        var blue = api.lut(
          [[0, 0.075], [0.2, 0.15], [0.55, 0.42], [0.85, 0.7], [1, 0.87]],
          { gain: 0.9, gamma: 1.02 }
        );

        for (var i = 0; i < data.length; i += 4) {
          data[i] = red[data[i]];
          data[i + 1] = green[data[i + 1]];
          data[i + 2] = blue[data[i + 2]];
          data[i + 3] = 255;
        }

        api.finish({ grain: 0.045, vignette: 0.25, warmHighlights: 1 });
      },
      finish: function (api) {
        api.wash("rgb(255, 150, 66)", 0.1, "soft-light");
        api.glow(26, 0.085);
      }
    },
    {
      id: "sage",
      label: "Sage",
      short: "Sage",
      blurb: "dusty green cast, measured contrast, botanical calm",
      keywords: {
        sage: 5,
        green: 4,
        botanical: 4,
        olive: 4,
        moss: 4,
        forest: 3,
        earthy: 3,
        "earthy tones": 4,
        "soft green": 4,
        plant: 2,
        natural: 2,
        desaturated: 2,
        muted: 2,
        calm: 2
      },
      apply: function (api) {
        var data = api.imageData.data;
        var tone = api.lut(
          [[0, 0.052], [0.2, 0.185], [0.55, 0.55], [0.85, 0.865], [1, 0.975]],
          { gamma: 1.01 }
        );

        for (var i = 0; i < data.length; i += 4) {
          var r = data[i];
          var g = data[i + 1];
          var b = data[i + 2];
          var luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

          r = luminance + (r - luminance) * 0.78;
          g = luminance + (g - luminance) * 0.72;
          b = luminance + (b - luminance) * 0.7;

          data[i] = api.tone(tone, r) * 0.995;
          data[i + 1] = api.tone(tone, g) * 1.012;
          data[i + 2] = api.tone(tone, b) * 0.975;
          data[i + 3] = 255;
        }

        api.finish({ grain: 0.05, vignette: 0.12 });
      },
      finish: function (api) {
        api.wash("rgb(146, 168, 118)", 0.055, "soft-light");
      }
    },
    {
      id: "copper-print",
      label: "Copper print",
      short: "Copper",
      blurb: "two-tone copper, hard edges, a print-like step",
      keywords: {
        copper: 4,
        "two tone": 4,
        duotone: 3,
        risograph: 4,
        halftone: 3,
        print: 2,
        poster: 2,
        graphic: 2,
        bold: 2,
        brass: 3,
        rust: 3,
        bronze: 3,
        texture: 1
      },
      apply: function (api) {
        var data = api.imageData.data;
        var tone = api.lut(
          [[0, 0.01], [0.22, 0.11], [0.5, 0.53], [0.78, 0.85], [1, 1]],
          { gamma: 1.08 }
        );
        var shadow = [46, 22, 12];
        var highlight = [246, 187, 129];

        for (var i = 0; i < data.length; i += 4) {
          var luminance = data[i] * 0.3 + data[i + 1] * 0.65 + data[i + 2] * 0.05;
          var base = tone[luminance <= 0 ? 0 : luminance >= 255 ? 255 : luminance | 0] / 255;
          var stepped = Math.round(base * 40) / 40;

          data[i] = shadow[0] + (highlight[0] - shadow[0]) * stepped;
          data[i + 1] = shadow[1] + (highlight[1] - shadow[1]) * stepped;
          data[i + 2] = shadow[2] + (highlight[2] - shadow[2]) * stepped;
          data[i + 3] = 255;
        }

        api.finish({ grain: 0.03, vignette: 0.16, warmHighlights: 0.4 });
      },
      finish: function (api) {
        api.wash("rgb(120, 62, 28)", 0.07, "soft-light");
      }
    },
    {
      id: "porcelain",
      label: "Porcelain",
      short: "Pale",
      blurb: "cool, pale skin tones, airy highlights",
      keywords: {
        porcelain: 5,
        "high key": 4,
        highkey: 3,
        pale: 3,
        airy: 3,
        lifted: 3,
        bright: 2,
        light: 2,
        clean: 2,
        minimal: 2,
        white: 2,
        soft: 2,
        delicate: 3,
        ethereal: 3,
        pastel: 2,
        "studio light": 3
      },
      apply: function (api) {
        var data = api.imageData.data;
        var tone = api.lut(
          [[0, 0.085], [0.22, 0.28], [0.55, 0.63], [0.85, 0.9], [1, 0.995]],
          { gamma: 0.94 }
        );

        for (var i = 0; i < data.length; i += 4) {
          var r = data[i];
          var g = data[i + 1];
          var b = data[i + 2];
          var luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

          r = luminance + (r - luminance) * 0.66;
          g = luminance + (g - luminance) * 0.66;
          b = luminance + (b - luminance) * 0.66;

          data[i] = api.tone(tone, r * 1.01);
          data[i + 1] = api.tone(tone, g) * 1.018;
          data[i + 2] = api.tone(tone, b * 1.02) * 1.055;
          data[i + 3] = 255;
        }

        api.finish({
          grain: 0.028,
          vignette: 0.04,
          coolHighlights: 0.7,
          coolShadows: 0.34
        });
      },
      finish: function (api) {
        api.glow(22, 0.065);
        api.wash("rgb(228, 238, 255)", 0.05, "screen");
      }
    },
    {
      id: "midnight",
      label: "Midnight",
      short: "Night",
      blurb: "deep blue blacks, one cool key light, quiet grain",
      keywords: {
        midnight: 5,
        night: 4,
        navy: 4,
        "deep blue": 4,
        "low key": 4,
        lowkey: 3,
        dark: 3,
        moody: 3,
        moonlight: 3,
        "moon light": 3,
        shadow: 2,
        shadows: 2,
        black: 2,
        cinematic: 2,
        dramatic: 2
      },
      apply: function (api) {
        var data = api.imageData.data;
        var tone = api.lut(
          [[0, 0.012], [0.2, 0.105], [0.5, 0.47], [0.8, 0.82], [1, 0.965]],
          { gamma: 1.06 }
        );

        for (var i = 0; i < data.length; i += 4) {
          data[i] = api.tone(tone, data[i] * 0.74) * 0.94;
          data[i + 1] = api.tone(tone, data[i + 1] * 0.84) * 0.99;
          data[i + 2] = api.tone(tone, data[i + 2] * 1.08) * 1.05;
          data[i + 3] = 255;
        }

        api.finish({
          grain: 0.058,
          vignette: 0.3,
          coolShadows: 1.35,
          coolHighlights: 0.4
        });
      },
      finish: function (api) {
        api.wash("rgb(20, 40, 82)", 0.12, "soft-light");
      }
    }
  ];

  var STYLE_BY_ID = new Map(
    STYLES.map(function (style) {
      return [style.id, style];
    })
  );

  var STYLE_RESPONSES = {
    "warm-film": [
      "Highlights lean into late-summer gold while the shadows keep a trace of warmth, and a fine grain settles over the whole frame.",
      "The whites take on a honeyed edge, the shadows stay open, and a soft halation collects around the brightest edges."
    ],
    noir: [
      "Colour is gone, replaced by a silver-scale response with deep, clean blacks and a long highlight roll-off.",
      "A true monochrome conversion, with contrast pushed until the midtones separate and the grain reads as texture."
    ],
    cyanotype: [
      "The frame is mapped into mineral blues, with paper-white highlights and a cool, measured contrast curve.",
      "A sun-print palette: navy in the shadows, pale cyan in the light, and a quiet grain through the midtones."
    ],
    "amber-dusk": [
      "The light drops into a low amber register, with copper highlights, softer edges and a warm haze over the deepest shadows.",
      "An evening grade: ember tones in the light, brown-black shadows, and a gentle bloom around every bright source."
    ],
    sage: [
      "The palette shifts toward dusty olive, with measured contrast and enough desaturation to feel botanical rather than digital.",
      "Green moves into the midtones, reds calm down, and the whole frame takes on a quiet, earthy restraint."
    ],
    "copper-print": [
      "The image is reduced to two inks — deep copper-brown shadows and warm paper highlights — with a print-like step through the midtones.",
      "A graphic, two-tone rendering: hard-edged copper ink over warm stock, finished with a faint press texture."
    ],
    porcelain: [
      "Shadows lift into pale grey, highlights cool toward porcelain, and the contrast softens into an airy, studio-light calm.",
      "A high-key treatment: bright, cool whites, delicate midtones, and a light diffusion over the whole frame."
    ],
    midnight: [
      "Blacks sink into navy, highlights cool toward moonlight, and the contrast tightens around the midtones.",
      "A night grade: deep blue shadows, a single cool key light, and a quiet grain through the dark."
    ]
  };

  var WORKING_STAGES = [
    "Reading the frame",
    "Balancing the light",
    "Applying the grade",
    "Exporting the JPEG"
  ];

  /* ------------------------------------------------------------------------
     Cached lookups
     ------------------------------------------------------------------------ */

  function byId(id) {
    return document.getElementById(id);
  }

  var refs = {
    stage: byId("stage"),
    dropzone: byId("dropzone"),
    thread: byId("thread"),
    messages: byId("messages"),
    empty: byId("empty"),
    emptyChoose: byId("empty-choose"),
    emptySample: byId("empty-sample"),
    jump: byId("jump-button"),
    composer: byId("composer"),
    attachmentRow: byId("attachment-row"),
    attachmentList: byId("attachment-list"),
    attachButton: byId("attach-button"),
    attachMenu: byId("attach-menu"),
    menuLast: byId("menu-last"),
    menuLastDetail: byId("menu-last-detail"),
    menuClear: byId("menu-clear"),
    menuClearDetail: byId("menu-clear-detail"),
    prompt: byId("prompt"),
    sendButton: byId("send-button"),
    composerHint: byId("composer-hint"),
    fileInput: byId("file-input"),
    clearButton: byId("clear-button"),
    clearDialog: byId("clear-dialog"),
    toasts: byId("toasts"),
    lightbox: byId("lightbox"),
    lightboxScrim: byId("lightbox-scrim"),
    lightboxTitle: byId("lightbox-title"),
    lightboxMeta: byId("lightbox-meta"),
    lightboxImage: byId("lightbox-image"),
    lightboxClose: byId("lightbox-close"),
    lightboxDownload: byId("lightbox-download"),
    lightboxEdit: byId("lightbox-edit")
  };

  var suggestions = Array.prototype.slice.call(
    document.querySelectorAll(".suggestion")
  );

  /* ------------------------------------------------------------------------
     State
     ------------------------------------------------------------------------ */

  var state = {
    follow: true,
    pending: [],
    lastResult: null,
    lastStyleId: null,
    busy: false,
    generation: 0,
    menuOpen: false,
    renderCount: 0
  };

  var activeJobs = new Set();
  var resultAttachmentCache = new Map();
  var trackedUrls = new Set();
  var dragDepth = 0;
  var resizeFrame = 0;
  var clearReturnFocus = null;

  var lightboxState = {
    open: false,
    record: null,
    lastFocus: null,
    hideTimer: 0
  };

  var timeFormatter = (function () {
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch (error) {
      return null;
    }
  })();

  /* ------------------------------------------------------------------------
     Small utilities
     ------------------------------------------------------------------------ */

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function clamp01(value) {
    return value < 0 ? 0 : value > 1 ? 1 : value;
  }

  function clampByte(value) {
    if (value <= 0) {
      return 0;
    }
    if (value >= 255) {
      return 255;
    }
    return value | 0;
  }

  function smoothstep(edge0, edge1, value) {
    if (edge1 === edge0) {
      return value < edge0 ? 0 : 1;
    }
    var t = clamp01((value - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
  }

  function sleep(milliseconds) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, milliseconds);
    });
  }

  function nextFrame() {
    return new Promise(function (resolve) {
      window.requestAnimationFrame(function () {
        resolve();
      });
    });
  }

  function uniqueId(prefix) {
    return (
      prefix +
      "_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 8)
    );
  }

  function hashString(value) {
    var input = String(value || "");
    var h1 = 0xdeadbeef ^ input.length;
    var h2 = 0x41c6ce57 ^ input.length;

    for (var i = 0; i < input.length; i += 1) {
      var character = input.charCodeAt(i);
      h1 = Math.imul(h1 ^ character, 2654435761);
      h2 = Math.imul(h2 ^ character, 1597334677);
    }

    h1 =
      Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
      Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 =
      Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
      Math.imul(h1 ^ (h1 >>> 13), 3266489909);

    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  function mulberry32(seed) {
    var value = seed >>> 0;
    return function random() {
      value = (value + 0x6d2b79f5) | 0;
      var t = Math.imul(value ^ (value >>> 15), 1 | value);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function timeLabel(date) {
    if (!timeFormatter) {
      return "";
    }
    try {
      return timeFormatter.format(date || new Date());
    } catch (error) {
      return "";
    }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "";
    }
    if (bytes < 1024) {
      return bytes + " B";
    }
    if (bytes < 1024 * 1024) {
      return (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0) + " KB";
    }
    return (bytes / (1024 * 1024)).toFixed(
      bytes < 10 * 1024 * 1024 ? 1 : 0
    ) + " MB";
  }

  function dataUrlByteLength(dataUrl) {
    if (typeof dataUrl !== "string" || dataUrl.slice(0, 5) !== "data:") {
      return 0;
    }
    var comma = dataUrl.indexOf(",");
    if (comma < 0) {
      return 0;
    }
    var payload = dataUrl.slice(comma + 1);
    var padding = payload.slice(-2) === "==" ? 2 : payload.slice(-1) === "=" ? 1 : 0;
    return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
  }

  function excerpt(value, maxLength) {
    var clean = String(value || "")
      .replace(/\s+/g, " ")
      .trim();
    var clipped = clean.length > maxLength;

    if (clean.length > maxLength) {
      clean = clean.slice(0, Math.max(1, maxLength - 1));
    }

    clean = clean.replace(/[\s,;:—–-]+$/, "");

    return { text: clean, clipped: clipped };
  }

  function safeFilename(value, fallback) {
    var clean = String(value || "")
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    return clean || fallback || "bigmix.jpg";
  }

  function normalizePrompt(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function countPhrase(haystack, phrase) {
    if (!haystack || !phrase) {
      return 0;
    }
    var padded = " " + haystack + " ";
    var needle = " " + phrase + " ";
    var count = 0;
    var index = padded.indexOf(needle);
    while (index !== -1) {
      count += 1;
      index = padded.indexOf(needle, index + needle.length);
    }
    return count;
  }

  function plural(count, singular, pluralForm) {
    return count === 1 ? singular : pluralForm || singular + "s";
  }

  function isReducedMotion() {
    return Boolean(REDUCED_MOTION && REDUCED_MOTION.matches);
  }

  function isTouchFirst() {
    if (window.matchMedia) {
      if (window.matchMedia("(hover: none), (pointer: coarse)").matches) {
        return true;
      }
      if (window.matchMedia("(hover: hover), (pointer: fine)").matches) {
        return false;
      }
    }

    return typeof navigator !== "undefined" &&
      Number(navigator.maxTouchPoints) > 0
      ? true
      : false;
  }

  /* ------------------------------------------------------------------------
     DOM helpers
     ------------------------------------------------------------------------ */

  function h(tag, props) {
    var node = document.createElement(tag);
    var children = Array.prototype.slice.call(arguments, 2);

    if (props) {
      Object.keys(props).forEach(function (key) {
        var value = props[key];

        if (value === undefined || value === null || value === false) {
          return;
        }

        if (key === "class" || key === "className") {
          node.className = value;
        } else if (key === "text") {
          node.textContent = value;
        } else if (key === "html") {
          node.innerHTML = value;
        } else if (key === "dataset") {
          Object.assign(node.dataset, value);
        } else if (key === "style" && typeof value === "object") {
          Object.keys(value).forEach(function (property) {
            var propertyValue = value[property];
            if (propertyValue === undefined || propertyValue === null) {
              return;
            }
            if (property.slice(0, 2) === "--") {
              node.style.setProperty(property, String(propertyValue));
            } else {
              node.style[property] = propertyValue;
            }
          });
        } else if (
          key.slice(0, 2) === "on" &&
          typeof value === "function"
        ) {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (value === true) {
          node.setAttribute(key, "");
        } else {
          node.setAttribute(key, String(value));
        }
      });
    }

    appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    children.forEach(function (child) {
      if (child === null || child === undefined || child === false) {
        return;
      }
      if (Array.isArray(child)) {
        appendChildren(node, child);
        return;
      }
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
  }

  function createIcon(name) {
    var namespace = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("class", "ic");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");

    var use = document.createElementNS(namespace, "use");
    use.setAttribute("href", "#i-" + name);
    use.setAttributeNS(
      "http://www.w3.org/1999/xlink",
      "xlink:href",
      "#i-" + name
    );

    svg.append(use);
    return svg;
  }

  /* ------------------------------------------------------------------------
     Toasts
     ------------------------------------------------------------------------ */

  function toast(message, tone) {
    var container = refs.toasts;
    if (!container) {
      return;
    }

    var node = h(
      "div",
      { class: "toast toast--" + (tone || "info") },
      h("span", { class: "toast__mark", "aria-hidden": "true" }),
      h("span", { text: String(message) })
    );

    container.append(node);

    while (container.childElementCount > 4) {
      container.firstElementChild.remove();
    }

    window.setTimeout(function () {
      node.classList.add("is-leaving");
      window.setTimeout(function () {
        node.remove();
      }, 220);
    }, 3800);
  }

  /* ------------------------------------------------------------------------
     Colour grading primitives
     ------------------------------------------------------------------------ */

  function interpolateStops(stops, x) {
    if (x <= stops[0][0]) {
      return stops[0][1];
    }
    var last = stops[stops.length - 1];
    if (x >= last[0]) {
      return last[1];
    }

    for (var i = 1; i < stops.length; i += 1) {
      var x1 = stops[i - 1][0];
      var y1 = stops[i - 1][1];
      var x2 = stops[i][0];
      var y2 = stops[i][1];

      if (x <= x2) {
        var t = clamp01((x - x1) / Math.max(1e-6, x2 - x1));
        var eased = t * t * (3 - 2 * t);
        return y1 + (y2 - y1) * eased;
      }
    }

    return last[1];
  }

  function makeLut(stops, options) {
    var settings = options || {};
    var gamma = typeof settings.gamma === "number" ? settings.gamma : 1;
    var gain = typeof settings.gain === "number" ? settings.gain : 1;
    var lift = typeof settings.lift === "number" ? settings.lift : 0;
    var sorted = stops
      .slice()
      .sort(function (a, b) {
        return a[0] - b[0];
      });
    var lut = new Uint8ClampedArray(256);

    for (var i = 0; i < 256; i += 1) {
      var value = interpolateStops(sorted, i / 255);
      value = Math.pow(clamp01(value), gamma) * gain + lift;
      lut[i] = Math.round(clamp01(value) * 255);
    }

    return lut;
  }

  function toneAt(lut, value) {
    return lut[clampByte(value)];
  }

  function finishPixels(api, options) {
    var settings = options || {};
    var grain = settings.grain || 0;
    var vignette = settings.vignette || 0;
    var warmHighlights = settings.warmHighlights || 0;
    var coolHighlights = settings.coolHighlights || 0;
    var coolShadows = settings.coolShadows || 0;

    if (
      !grain &&
      !vignette &&
      !warmHighlights &&
      !coolHighlights &&
      !coolShadows
    ) {
      return;
    }

    var data = api.imageData.data;
    var width = api.width;
    var height = api.height;
    var random = api.rand;
    var invWidth = width > 1 ? 1 / (width - 1) : 0;
    var invHeight = height > 1 ? 1 / (height - 1) : 0;

    for (var y = 0; y < height; y += 1) {
      var ny = y * invHeight * 2 - 1;

      for (var x = 0; x < width; x += 1) {
        var index = (y * width + x) * 4;
        var r = data[index];
        var g = data[index + 1];
        var b = data[index + 2];

        if (warmHighlights || coolHighlights) {
          var highlightLum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          var highlightMask = smoothstep(146, 255, highlightLum);

          if (warmHighlights) {
            r += highlightMask * 24 * warmHighlights;
            g += highlightMask * 6 * warmHighlights;
            b -= highlightMask * 13 * warmHighlights;
          }

          if (coolHighlights) {
            b += highlightMask * 22 * coolHighlights;
            r -= highlightMask * 9 * coolHighlights;
          }
        }

        if (coolShadows) {
          var shadowLum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          var shadowMask = 1 - smoothstep(0, 98, shadowLum);
          b += shadowMask * 16 * coolShadows;
          g += shadowMask * 5 * coolShadows;
          r -= shadowMask * 4 * coolShadows;
        }

        if (vignette) {
          var nx = x * invWidth * 2 - 1;
          var distance = Math.sqrt(nx * nx + ny * ny) / 1.41421356237;
          var falloff = 1 - vignette * smoothstep(0.42, 1, distance);
          r *= falloff;
          g *= falloff;
          b *= falloff;
        }

        if (grain) {
          var grainLum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          var highlightFalloff =
            1 - 0.6 * (clamp01(grainLum / 255) * clamp01(grainLum / 255));
          var noise = random() + random() - 1;
          var delta = noise * grain * 44 * highlightFalloff;
          r += delta;
          g += delta;
          b += delta;
        }

        data[index] = r;
        data[index + 1] = g;
        data[index + 2] = b;
        data[index + 3] = 255;
      }
    }
  }

  function washCanvas(canvas, color, alpha, mode) {
    var context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    context.save();
    context.globalCompositeOperation = mode || "soft-light";
    context.globalAlpha = clamp(alpha, 0, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();
  }

  function glowCanvas(canvas, blur, strength) {
    try {
      var width = canvas.width;
      var height = canvas.height;
      if (!width || !height) {
        return;
      }

      var layer = document.createElement("canvas");
      layer.width = Math.max(1, Math.round(width * 0.5));
      layer.height = Math.max(1, Math.round(height * 0.5));

      var layerContext = layer.getContext("2d");
      if (!layerContext) {
        return;
      }

      layerContext.imageSmoothingEnabled = true;
      layerContext.imageSmoothingQuality = "high";
      layerContext.drawImage(canvas, 0, 0, layer.width, layer.height);

      var context = canvas.getContext("2d");
      if (!context) {
        return;
      }

      context.save();
      context.globalCompositeOperation = "screen";
      context.globalAlpha = clamp(strength, 0, 1);
      if ("filter" in context) {
        context.filter = "blur(" + blur + "px)";
      }
      context.drawImage(layer, 0, 0, width, height);
      context.restore();

      layer.width = 0;
      layer.height = 0;
    } catch (error) {
      /* Glow is a finishing touch — never let it abort a render. */
    }
  }

  /* ------------------------------------------------------------------------
     Image I/O
     ------------------------------------------------------------------------ */

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        if (typeof reader.result === "string" && reader.result.indexOf("data:") === 0) {
          resolve(reader.result);
        } else {
          reject(new Error("The file could not be read as an image."));
        }
      };
      reader.onerror = function () {
        reject(reader.error || new Error("The file could not be read."));
      };
      reader.onabort = function () {
        reject(new Error("Reading the file was cancelled."));
      };
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.decoding = "async";

      image.onload = function () {
        if (!image.naturalWidth || !image.naturalHeight) {
          reject(new Error("The image has no readable dimensions."));
          return;
        }
        resolve(image);
      };

      image.onerror = function () {
        reject(new Error("The image could not be decoded."));
      };

      image.src = src;
    });
  }

  function fingerprintPixels(imageData) {
    var data = imageData.data;
    var total = data.length / 4;
    var stride = Math.max(1, Math.floor(total / 512));
    var hash = 0x811c9dc5;

    for (var index = 0; index < total; index += stride) {
      var offset = index * 4;
      hash ^= data[offset] + (data[offset + 1] << 8) + (data[offset + 2] << 16);
      hash = Math.imul(hash, 16777619) >>> 0;
    }

    return hash.toString(16);
  }

  function createThumbnail(image) {
    try {
      var width = image.naturalWidth || image.width;
      var height = image.naturalHeight || image.height;

      if (!width || !height) {
        return "";
      }

      var scale = Math.min(1, THUMBNAIL_SIZE / Math.max(width, height));
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));

      var context = canvas.getContext("2d");
      if (!context) {
        return "";
      }

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      var thumbnail = canvas.toDataURL("image/jpeg", 0.82);
      canvas.width = 0;
      canvas.height = 0;

      return thumbnail.indexOf("data:image") === 0 ? thumbnail : "";
    } catch (error) {
      return "";
    }
  }

  function createThumbnailFromSrc(src) {
    return loadImage(src).then(function (image) {
      return createThumbnail(image) || src;
    });
  }

  function resolveMimeType(file) {
    var mime = String(file.type || "").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(MIME_TO_EXTENSION, mime)) {
      return mime;
    }

    var name = String(file.name || "");
    var dot = name.lastIndexOf(".");
    if (dot === -1) {
      return null;
    }

    var extension = name.slice(dot + 1).toLowerCase();
    return Object.prototype.hasOwnProperty.call(EXTENSION_TO_MIME, extension)
      ? EXTENSION_TO_MIME[extension]
      : null;
  }

  function dataUrlToBlob(dataUrl) {
    var comma = dataUrl.indexOf(",");
    var header = dataUrl.slice(0, comma);
    var payload = dataUrl.slice(comma + 1);
    var mimeMatch = /data:([^;]+)/.exec(header);
    var mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
    var binary = window.atob(payload);
    var bytes = new Uint8Array(binary.length);

    for (var i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    return new Blob([bytes], { type: mime });
  }

  function trackedObjectUrl(blob) {
    var url = URL.createObjectURL(blob);
    trackedUrls.add(url);
    window.setTimeout(function () {
      if (trackedUrls.has(url)) {
        URL.revokeObjectURL(url);
        trackedUrls.delete(url);
      }
    }, 4000);
    return url;
  }

  async function downloadImage(src, filename) {
    var name = safeFilename(filename, "bigmix.jpg");
    if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
      name += ".jpg";
    }

    try {
      var href = src;

      if (typeof src === "string" && src.indexOf("data:") === 0) {
        href = trackedObjectUrl(dataUrlToBlob(src));
      }

      var link = document.createElement("a");
      link.href = href;
      link.download = name;
      link.rel = "noopener";
      link.style.position = "fixed";
      link.style.opacity = "0";
      link.style.pointerEvents = "none";
      link.style.left = "-9999px";
      document.body.append(link);
      link.click();
      link.remove();
    } catch (error) {
      toast("The download could not start. Try opening the image first.", "error");
    }
  }

  /* ------------------------------------------------------------------------
     Prompt understanding
     ------------------------------------------------------------------------ */

  function chooseStyle(promptText, previousId) {
    var normalized = normalizePrompt(promptText);
    var bestScore = 0;
    var candidates = [];

    STYLES.forEach(function (style) {
      var score = 0;

      Object.keys(style.keywords).forEach(function (phrase) {
        var hits = countPhrase(normalized, phrase);
        if (hits > 0) {
          score += hits * style.keywords[phrase];
        }
      });

      if (score > bestScore) {
        bestScore = score;
        candidates = [style];
      } else if (score === bestScore && score > 0) {
        candidates.push(style);
      }
    });

    if (bestScore > 0 && candidates.length) {
      var preferred = candidates.find(function (style) {
        return style.id === previousId;
      });
      return { style: preferred || candidates[0], auto: false };
    }

    if (previousId && STYLE_BY_ID.has(previousId)) {
      var index = STYLES.findIndex(function (style) {
        return style.id === previousId;
      });
      return {
        style: STYLES[(index + 1) % STYLES.length],
        auto: true
      };
    }

    var hash = hashString(normalized || "bigmix");
    return { style: STYLES[hash % STYLES.length], auto: true };
  }

  function pickResponse(styleId, seedText) {
    var options = STYLE_RESPONSES[styleId];
    if (!options || !options.length) {
      return "The frame takes a new colour direction while every structural detail stays exactly where it was.";
    }
    var index = Math.abs(hashString(seedText)) % options.length;
    return options[index];
  }

  /* ------------------------------------------------------------------------
     The renderer
     ------------------------------------------------------------------------ */

  async function renderEdit(options) {
    var source = options.source;
    var style = options.style;
    var prompt = options.prompt;

    var image = await loadImage(source.src);
    var width = image.naturalWidth || image.width || source.width;
    var height = image.naturalHeight || image.height || source.height;

    if (!width || !height) {
      throw new Error("The source image has no readable dimensions.");
    }

    if (width * height > MAX_PIXELS) {
      throw new Error("This frame has too many pixels to grade in the browser.");
    }

    var canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    var context = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true
    });

    if (!context) {
      throw new Error("This browser did not provide a Canvas 2D context.");
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);

    var imageData;

    try {
      imageData = context.getImageData(0, 0, width, height);
    } catch (error) {
      throw new Error(
        "The canvas could not read this image. Pixel access may be blocked by the browser."
      );
    }

    // The seed is derived from the pixels themselves, so re-running the same
    // instruction on the same frame always yields byte-identical output.
    var seed = hashString(
      [
        style.id,
        fingerprintPixels(imageData),
        width + "x" + height,
        normalizePrompt(prompt)
      ].join("|")
    );

    var random = mulberry32(seed);

    var api = {
      canvas: canvas,
      ctx: context,
      imageData: imageData,
      width: width,
      height: height,
      rand: random,
      lut: makeLut,
      tone: toneAt,
      finish: function (settings) {
        finishPixels(api, settings);
      },
      glow: function (blur, strength) {
        glowCanvas(canvas, blur, strength);
      },
      wash: function (color, alpha, mode) {
        washCanvas(canvas, color, alpha, mode);
      }
    };

    style.apply(api);
    context.putImageData(imageData, 0, 0);

    if (typeof style.finish === "function") {
      style.finish(api);
    }

    var dataUrl;

    try {
      dataUrl = canvas.toDataURL("image/jpeg", EXPORT_QUALITY);
    } catch (error) {
      throw new Error(
        "The browser blocked the JPEG export. Local files and same-origin images can be exported."
      );
    }

    canvas.width = 0;
    canvas.height = 0;

    if (!dataUrl || dataUrl.indexOf("data:image/jpeg") !== 0) {
      throw new Error("The rendered frame could not be exported as a JPEG.");
    }

    return {
      src: dataUrl,
      width: width,
      height: height,
      styleId: style.id
    };
  }

  /* ------------------------------------------------------------------------
     Attachments
     ------------------------------------------------------------------------ */

  function sizeLabel(attachment) {
    if (attachment.origin === "sample") {
      return "sample";
    }
    return formatBytes(attachment.size);
  }

  function isDuplicate(candidate, list) {
    var pool = list || state.pending;
    return pool.some(function (existing) {
      if (candidate.key && existing.key) {
        return candidate.key === existing.key;
      }
      return (
        existing.origin === candidate.origin &&
        existing.name === candidate.name &&
        existing.size === candidate.size
      );
    });
  }

  async function prepareAttachment(file, mime) {
    var src = await readFileAsDataUrl(file);
    var image = await loadImage(src);
    var width = image.naturalWidth;
    var height = image.naturalHeight;

    if (width < MIN_SIDE || height < MIN_SIDE) {
      throw new Error("The image is too small to edit.");
    }

    if (width * height > MAX_PIXELS) {
      throw new Error("The image has too many pixels to edit in the browser.");
    }

    var thumbnail = createThumbnail(image);
    var extension = MIME_TO_EXTENSION[mime] || "jpg";
    var name = safeFilename(file.name, "image." + extension);
    if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
      name += "." + extension;
    }

    return {
      id: uniqueId("att"),
      key: "file:" + name + ":" + file.size + ":" + (file.lastModified || 0),
      name: name,
      size: file.size,
      type: mime,
      src: src,
      thumb: thumbnail || src,
      width: width,
      height: height,
      origin: "upload"
    };
  }

  async function intakeFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) {
      return;
    }

    var added = [];
    var problems = [];
    var skippedForLimit = 0;

    for (var i = 0; i < files.length; i += 1) {
      var file = files[i];

      if (state.pending.length + added.length >= MAX_FILES) {
        skippedForLimit += 1;
        continue;
      }

      var mime = resolveMimeType(file);

      if (!mime) {
        var extension = String(file.name || "").split(".").pop().toLowerCase();
        if (VIDEO_EXTENSIONS.indexOf(extension) !== -1) {
          problems.push("Video files are not supported — attach a JPEG, PNG or WebP frame.");
        } else {
          problems.push("“" + (file.name || "That file") + "” is not a JPEG, PNG or WebP image.");
        }
        continue;
      }

      if (file.size > MAX_BYTES) {
        problems.push("“" + (file.name || "That image") + "” is larger than 20 MB.");
        continue;
      }

      try {
        var attachment = await prepareAttachment(file, mime);

        if (isDuplicate(attachment, state.pending.concat(added))) {
          problems.push("“" + attachment.name + "” is already attached.");
          continue;
        }

        added.push(attachment);
      } catch (error) {
        problems.push(
          "“" + (file.name || "That image") + "” could not be read. " +
            (error && error.message ? error.message : "")
        );
      }
    }

    if (added.length) {
      state.pending = state.pending.concat(added);
      renderAttachmentRow({ scrollToEnd: true });
      updateComposer();
      promptFocus();
      toast(
        added.length === 1
          ? "“" + added[0].name + "” attached."
          : added.length + " images attached.",
        "ok"
      );
    }

    if (skippedForLimit) {
      problems.unshift(
        "Up to " + MAX_FILES + " images can be attached at once — " +
          skippedForLimit + " skipped."
      );
    }

    if (problems.length) {
      toast(
        problems[0] +
          (problems.length > 1 ? " (+" + (problems.length - 1) + " more)" : ""),
        "error"
      );
    }
  }

  function addPreparedAttachment(candidate) {
    if (state.pending.length >= MAX_FILES) {
      toast(
        "Up to " + MAX_FILES + " images can be attached at once.",
        "error"
      );
      return false;
    }

    if (isDuplicate(candidate)) {
      toast("“" + candidate.name + "” is already attached.", "info");
      return false;
    }

    state.pending.push(candidate);
    renderAttachmentRow({ scrollToEnd: true });
    updateComposer();
    return true;
  }

  async function addResultAttachment(result) {
    if (!result) {
      return false;
    }

    if (state.pending.length >= MAX_FILES) {
      toast(
        "Up to " + MAX_FILES + " images can be attached at once.",
        "error"
      );
      return false;
    }

    var attachment = resultAttachmentCache.get(result.id);

    if (!attachment) {
      var thumbnail = "";
      try {
        thumbnail = await createThumbnailFromSrc(result.src);
      } catch (error) {
        thumbnail = result.src;
      }

      attachment = {
        id: uniqueId("result"),
        key: "result:" + result.id,
        name: safeFilename(result.filename, "bigmix-" + result.styleId + ".jpg"),
        size: dataUrlByteLength(result.src),
        type: "image/jpeg",
        src: result.src,
        thumb: thumbnail || result.src,
        width: result.width,
        height: result.height,
        origin: "result"
      };

      resultAttachmentCache.set(result.id, attachment);
    }

    var added = addPreparedAttachment(Object.assign({}, attachment));
    if (added) {
      promptFocus();
      toast("Result attached — describe the next change.", "ok");
    }
    return added;
  }

  async function addSample() {
    if (state.pending.length >= MAX_FILES) {
      toast(
        "Up to " + MAX_FILES + " images can be attached at once.",
        "error"
      );
      return;
    }

    if (isDuplicate({ key: SAMPLE.key })) {
      toast("The sample image is already attached.", "info");
      return;
    }

    refs.emptySample.disabled = true;

    try {
      var image = await loadImage(SAMPLE.src);
      var attachment = {
        id: uniqueId("sample"),
        key: SAMPLE.key,
        name: SAMPLE.name,
        size: 0,
        type: "image/jpeg",
        src: SAMPLE.src,
        thumb: createThumbnail(image) || SAMPLE.src,
        width: image.naturalWidth || SAMPLE.width,
        height: image.naturalHeight || SAMPLE.height,
        origin: "sample"
      };

      if (addPreparedAttachment(attachment)) {
        promptFocus();
        toast("Sample attached — describe a change, or send as is.", "ok");
      }
    } catch (error) {
      toast("The sample image could not be loaded. Choose a file instead.", "error");
    } finally {
      refs.emptySample.disabled = false;
    }
  }

  function removeAttachment(id) {
    state.pending = state.pending.filter(function (attachment) {
      return attachment.id !== id;
    });
    renderAttachmentRow();
    updateComposer();
  }

  function clearPendingAttachments() {
    if (!state.pending.length) {
      return;
    }

    var count = state.pending.length;
    state.pending = [];
    renderAttachmentRow();
    updateComposer();
    toast(
      count + " " + plural(count, "attachment") + " removed.",
      "info"
    );
  }

  function restoreAttachments(attachments) {
    if (!attachments || !attachments.length || state.pending.length > 0) {
      return 0;
    }

    var restored = 0;

    attachments.forEach(function (attachment) {
      if (state.pending.length >= MAX_FILES) {
        return;
      }
      if (isDuplicate(attachment)) {
        return;
      }
      state.pending.push(Object.assign({}, attachment));
      restored += 1;
    });

    if (restored) {
      renderAttachmentRow({ scrollToEnd: true });
      updateComposer();
    }

    return restored;
  }

  /* ------------------------------------------------------------------------
     Chips
     ------------------------------------------------------------------------ */

  function attachmentRecord(attachment) {
    return {
      src: attachment.src,
      title: attachment.name,
      meta:
        attachment.width +
        " × " +
        attachment.height +
        " · " +
        (sizeLabel(attachment) || "image") +
        (attachment.origin === "upload"
          ? " · original"
          : attachment.origin === "sample"
            ? " · sample frame"
            : " · local render"),
      downloadName: downloadNameFor(attachment),
      alt: attachment.name
    };
  }

  function downloadNameFor(attachment) {
    var name = safeFilename(attachment.name, "image.jpg");
    if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
      name += "." + (MIME_TO_EXTENSION[attachment.type] || "jpg");
    }
    return name;
  }

  function openAttachmentLightbox(attachment, allowAttach) {
    var record = attachmentRecord(attachment);

    if (allowAttach) {
      record.onEdit = function () {
        return Promise.resolve().then(function () {
          var added = addPreparedAttachment(Object.assign({}, attachment));
          if (added) {
            promptFocus();
            toast("Added to attachments — describe the next change.", "ok");
          }
        });
      };
    }

    openLightbox(record);
  }

  function createChip(attachment, options) {
    var settings = options || {};
    var removable = Boolean(settings.removable);
    var variant = settings.variant === "message" ? " chip--message" : "";
    var wrapper = h(removable ? "div" : "button", {
      class: "chip chip--button" + variant,
      type: removable ? undefined : "button",
      "aria-label": removable
        ? undefined
        : "View " + attachment.name + " at full size",
      title:
        attachment.name +
        " · " +
        attachment.width +
        " × " +
        attachment.height
    });

    var open = h(removable ? "button" : "span", {
      class: "chip__open",
      type: removable ? "button" : undefined,
      "aria-label": removable
        ? "View " + attachment.name + " at full size"
        : undefined
    });

    open.append(
      h("img", {
        class: "chip__thumb",
        src: attachment.thumb || attachment.src,
        alt: "",
        loading: "lazy",
        decoding: "async",
        draggable: "false",
        width: "28",
        height: "28"
      }),
      h("span", { class: "chip__name", text: attachment.name })
    );

    var size = sizeLabel(attachment);
    if (size) {
      open.append(h("span", { class: "chip__size", text: size }));
    }

    var activate = function (event) {
      event.stopPropagation();
      openAttachmentLightbox(
        attachment,
        settings.allowAttach !== false && !removable
      );
    };

    if (removable) {
      open.addEventListener("click", activate);
      wrapper.append(open);

      var remove = h("button", {
        class: "chip__remove",
        type: "button",
        "aria-label": "Remove " + attachment.name
      });
      remove.append(createIcon("close"));
      remove.addEventListener("click", function (event) {
        event.stopPropagation();
        if (typeof settings.onRemove === "function") {
          settings.onRemove();
        }
      });
      wrapper.append(remove);
    } else {
      wrapper.addEventListener("click", activate);
      wrapper.append(open);
    }

    return wrapper;
  }

  function renderAttachmentRow(options) {
    var settings = options || {};
    var list = refs.attachmentList;

    refs.attachmentRow.hidden = state.pending.length === 0;
    list.replaceChildren();

    state.pending.forEach(function (attachment) {
      list.append(
        createChip(attachment, {
          removable: true,
          allowAttach: false,
          onRemove: function () {
            removeAttachment(attachment.id);
          }
        })
      );
    });

    if (settings.scrollToEnd && state.pending.length) {
      window.requestAnimationFrame(function () {
        list.scrollLeft = list.scrollWidth;
      });
    }

    syncMenu();
    updateClearButton();
  }

  /* ------------------------------------------------------------------------
     Composer
     ------------------------------------------------------------------------ */

  function promptFocus() {
    try {
      refs.prompt.focus({ preventScroll: true });
    } catch (error) {
      refs.prompt.focus();
    }
  }

  function autoGrowPrompt() {
    var element = refs.prompt;
    var base = 40;
    var maxHeight = Math.min(window.innerHeight * 0.4, 188);

    element.style.height = base + "px";

    if (!element.value) {
      element.style.overflowY = "hidden";
      return;
    }

    element.style.height = "auto";

    var contentHeight = element.scrollHeight;
    var nextHeight = clamp(contentHeight, base, maxHeight);

    element.style.height = nextHeight + "px";
    element.style.overflowY = contentHeight > maxHeight + 1 ? "auto" : "hidden";
  }

  function buildHint() {
    if (state.busy) {
      return isTouchFirst()
        ? "Rendering — one moment."
        : "Hold tight — the current render is finishing.";
    }

    var count = state.pending.length;

    if (count && refs.prompt.value.trim()) {
      if (isTouchFirst()) {
        return (
          count +
          " " +
          plural(count, "image") +
          " ready · tap send to render"
        );
      }
      return (
        count +
        " " +
        plural(count, "image") +
        " ready · Enter to send · Shift + Enter for a new line"
      );
    }

    if (count) {
      return (
        count +
        " " +
        plural(count, "image") +
        (count === 1 ? " is" : "s are") +
        (isTouchFirst()
          ? " attached — add an instruction, or send as is"
          : " attached — press Enter to send, or send as is")
      );
    }

    if (state.lastResult) {
      return isTouchFirst()
        ? "Continues from the last result"
        : "Nothing attached — your note continues from the last result";
    }

    return "Attach an image to begin.";
  }

  function updateComposer(options) {
    var settings = options || {};
    autoGrowPrompt();

    var text = refs.prompt.value.trim();
    var canSend =
      !state.busy && (text.length > 0 || state.pending.length > 0);

    refs.sendButton.disabled = !canSend;
    refs.sendButton.classList.toggle("is-busy", state.busy);
    refs.sendButton.setAttribute(
      "aria-label",
      state.busy ? "Rendering the current edit" : "Send edit"
    );

    refs.composerHint.textContent = settings.hint || buildHint();
    syncMenu();
  }

  function syncMenu() {
    var last = state.lastResult;

    refs.menuLast.disabled = !last;
    refs.menuLastDetail.textContent = last
      ? last.width + " × " + last.height + " · " + last.styleLabel
      : "Available after your first edit";

    refs.menuClear.disabled = state.pending.length === 0;
    refs.menuClearDetail.textContent = state.pending.length
      ? state.pending.length +
        " " +
        plural(state.pending.length, "image") +
        " attached"
      : "Nothing attached yet";
  }

  function updateClearButton() {
    refs.clearButton.disabled = refs.messages.childElementCount === 0;
  }

  function setMenu(open, options) {
    var settings = options || {};
    var next = Boolean(open);

    state.menuOpen = next;
    refs.attachMenu.hidden = !next;
    refs.attachButton.setAttribute("aria-expanded", next ? "true" : "false");

    if (next) {
      syncMenu();
      if (settings.keyboard) {
        var first = refs.attachMenu.querySelector(
          ".menu-item:not(:disabled)"
        );
        if (first) {
          first.focus();
        }
      }
    } else if (settings.focusTrigger) {
      refs.attachButton.focus();
    }
  }

  function openFilePicker() {
    refs.fileInput.value = "";
    refs.fileInput.click();
  }

  function nudgeAttachButton() {
    refs.attachButton.classList.remove("is-nudged");
    void refs.attachButton.offsetWidth;
    refs.attachButton.classList.add("is-nudged");
    window.setTimeout(function () {
      refs.attachButton.classList.remove("is-nudged");
    }, 720);
  }

  /* ------------------------------------------------------------------------
     Drag and drop
     ------------------------------------------------------------------------ */

  function hasFiles(event) {
    var transfer = event.dataTransfer;
    if (!transfer) {
      return false;
    }

    if (transfer.types) {
      if (typeof transfer.types.includes === "function") {
        return transfer.types.includes("Files");
      }
      for (var i = 0; i < transfer.types.length; i += 1) {
        if (transfer.types[i] === "Files") {
          return true;
        }
      }
    }

    var items = transfer.items;
    if (items) {
      for (var j = 0; j < items.length; j += 1) {
        if (items[j].kind === "file") {
          return true;
        }
      }
    }

    return false;
  }

  function setDragging(value) {
    refs.stage.classList.toggle("is-dragging", Boolean(value));
    refs.dropzone.setAttribute("aria-hidden", value ? "false" : "true");
  }

  function bindDragAndDrop() {
    refs.stage.addEventListener("dragenter", function (event) {
      if (!hasFiles(event)) {
        return;
      }
      event.preventDefault();
      dragDepth += 1;
      setDragging(true);
    });

    refs.stage.addEventListener("dragover", function (event) {
      if (!hasFiles(event)) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
      if (!dragDepth) {
        dragDepth = 1;
      }
      setDragging(true);
    });

    refs.stage.addEventListener("dragleave", function (event) {
      if (!dragDepth) {
        return;
      }
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        setDragging(false);
      }
    });

    refs.stage.addEventListener("drop", function (event) {
      if (!hasFiles(event)) {
        return;
      }
      event.preventDefault();
      dragDepth = 0;
      setDragging(false);

      if (state.busy) {
        toast("An edit is running — these will wait in the composer.", "info");
      }

      var files = event.dataTransfer ? event.dataTransfer.files : null;
      if (files && files.length) {
        void intakeFiles(files);
      }
    });

    window.addEventListener("dragover", function (event) {
      if (hasFiles(event)) {
        event.preventDefault();
      }
    });

    window.addEventListener("drop", function (event) {
      if (!event.defaultPrevented && hasFiles(event)) {
        event.preventDefault();
        dragDepth = 0;
        setDragging(false);
      }
    });

    window.addEventListener("dragend", function () {
      dragDepth = 0;
      setDragging(false);
    });

    window.addEventListener("blur", function () {
      dragDepth = 0;
      setDragging(false);
    });
  }

  /* ------------------------------------------------------------------------
     Messages
     ------------------------------------------------------------------------ */

  function resultWidth(ratio) {
    var safeRatio = clamp(Number.isFinite(ratio) && ratio > 0 ? ratio : 0.8, 0.08, 12);
    var maxHeight = clamp(window.innerHeight * 0.62, 300, 620);
    var width = 520;

    if (width / safeRatio > maxHeight) {
      width = maxHeight * safeRatio;
    }

    return Math.round(clamp(width, 150, 520));
  }

  function updateResultWidths() {
    if (!refs.messages) {
      return;
    }

    refs.messages.querySelectorAll(".result").forEach(function (node) {
      var ratio = Number(node.getAttribute("data-ratio")) || 0.8;
      node.style.setProperty("--result-w", resultWidth(ratio) + "px");
    });
  }

  function nearBottom() {
    var thread = refs.thread;
    return (
      thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140
    );
  }

  function updateJump() {
    if (!refs.jump) {
      return;
    }

    var thread = refs.thread;
    var overflowing = thread.scrollHeight - thread.clientHeight > 48;
    refs.jump.hidden = !overflowing || nearBottom();
  }

  function scrollToBottom(options) {
    var settings = options || {};
    if (!settings.force && !nearBottom()) {
      updateJump();
      return;
    }

    var behavior =
      settings.smooth !== false && !isReducedMotion() ? "smooth" : "auto";

    window.requestAnimationFrame(function () {
      refs.thread.scrollTo({
        top: refs.thread.scrollHeight,
        behavior: behavior
      });
      window.setTimeout(updateJump, behavior === "smooth" ? 420 : 40);
    });
  }

  function mountMessage(node, options) {
    var settings = options || {};
    var stick = settings.forceScroll ? true : nearBottom();

    refs.messages.append(node);
    refs.empty.hidden = true;
    updateClearButton();

    if (stick) {
      state.follow = true;
      scrollToBottom({ force: true, smooth: settings.smooth !== false });
    } else {
      updateJump();
    }
  }

  function buildAssistantHead(date) {
    return h(
      "div",
      { class: "assistant-head" },
      h(
        "span",
        { class: "assistant-mark", "aria-hidden": "true" },
        createIcon("sparkle")
      ),
      h("span", { text: "Bigmix" }),
      h("span", { class: "assistant-time", text: timeLabel(date) })
    );
  }

  function appendUserMessage(payload) {
    var article = h("article", { class: "message message--user" });
    var bubble = h("div", { class: "user-bubble" });

    if (payload.text) {
      bubble.append(h("p", { class: "user-bubble__text", text: payload.text }));
    }

    if (payload.attachments.length) {
      var row = h("div", {
        class: "message-attachments",
        role: "group",
        "aria-label": "Attached images"
      });

      payload.attachments.forEach(function (attachment) {
        row.append(
          createChip(attachment, {
            variant: "message",
            allowAttach: true
          })
        );
      });

      bubble.append(row);
    }

    article.append(bubble);

    var meta = h(
      "p",
      { class: "user-meta" },
      h("span", { text: timeLabel(new Date()) })
    );

    if (payload.attachments.length) {
      meta.append(
        h("span", { class: "user-meta__dot", "aria-hidden": "true" }),
        h("span", {
          text:
            payload.attachments.length +
            " " +
            plural(payload.attachments.length, "image") +
            " attached"
        })
      );
    }

    article.append(meta);
    mountMessage(article, { forceScroll: true, smooth: true });
  }

  function buildReply(payload) {
    var style = payload.style;
    var request = payload.request;
    var result = payload.result;
    var source = payload.source;
    var prompt = String(request.text || "").trim();
    var paragraph = h("p", { class: "assistant-copy" });

    if (request.implicit) {
      paragraph.append(document.createTextNode("Continuing from the last result, "));
    } else if (!prompt) {
      paragraph.append(document.createTextNode("No written direction this round, so "));
    }

    paragraph.append(h("strong", { text: style.label }));

    paragraph.append(
      document.createTextNode(
        " — " +
          pickResponse(style.id, style.id + "|" + result.id + "|" + prompt) +
          " No crop and no resample: the frame is still " +
          result.width +
          " × " +
          result.height +
          ", with the composition, focus and edges exactly where they were."
      )
    );

    if (prompt) {
      var requested = excerpt(prompt, LONG_PROMPT);
      var quoted = requested.text.replace(/[.!?]+$/, "");

      paragraph.append(document.createTextNode(" Your note — "));
      paragraph.append(
        h("em", {
          text: "“" + quoted + (requested.clipped ? "…”" : "”")
        })
      );
      paragraph.append(
        document.createTextNode(" — set the direction.")
      );
    }

    var others = request.attachments.length - 1;
    if (!request.implicit && others > 0) {
      paragraph.append(
        document.createTextNode(
          " “" +
            source.name +
            "” served as the base; the other " +
            others +
            " " +
            plural(others, "attachment") +
            " stayed in the record."
        )
      );
    }

    return paragraph;
  }

  function resultRecord(result, style) {
    return {
      src: result.src,
      title: result.filename,
      meta:
        result.width +
        " × " +
        result.height +
        " · JPEG · " +
        style.label +
        " · rendered locally",
      downloadName: result.filename,
      alt: style.label + " edit, " + result.width + " by " + result.height,
      onEdit: function () {
        return addResultAttachment(result);
      }
    };
  }

  function buildResultCard(result, style) {
    var ratio = result.width / result.height;
    var figure = h("figure", {
      class: "result",
      "data-ratio": String(ratio)
    });
    figure.style.setProperty("--result-w", resultWidth(ratio) + "px");

    var frame = h("div", { class: "result__frame" });

    var view = h("button", {
      class: "result__view",
      type: "button",
      "aria-label": "View " + result.filename + " at full size"
    });

    view.append(
      h("img", {
        class: "result__img",
        src: result.src,
        alt: style.label + " edit — " + result.width + " × " + result.height,
        width: String(result.width),
        height: String(result.height),
        decoding: "async",
        draggable: "false"
      })
    );

    view.addEventListener("click", function () {
      openLightbox(resultRecord(result, style));
    });

    var image = view.firstElementChild;
    var settle = function () {
      updateResultWidths();
      if (state.follow) {
        scrollToBottom({ force: true, smooth: false });
      } else {
        updateJump();
      }
    };
    image.addEventListener("load", settle);
    image.addEventListener("error", settle);

    var hint = h(
      "span",
      { class: "result__hint", "aria-hidden": "true" },
      createIcon("expand"),
      h("span", { text: "View full size" })
    );

    var download = h(
      "button",
      {
        class: "result__download",
        type: "button",
        "aria-label": "Download " + result.filename
      },
      createIcon("download"),
      h("span", { text: "Download" })
    );

    download.addEventListener("click", function (event) {
      event.stopPropagation();
      void downloadImage(result.src, result.filename);
    });

    frame.append(view, hint, download);

    var meta = h("figcaption", { class: "result-meta" });
    meta.append(
      h("span", {
        class: "result-meta__item",
        text: result.width + " × " + result.height
      }),
      h("span", { class: "result-meta__dot", "aria-hidden": "true" }),
      h("span", { class: "result-meta__item", text: "JPEG" }),
      h("span", { class: "result-meta__dot", "aria-hidden": "true" }),
      h("span", {
        class: "result-meta__item result-meta__style",
        text: style.label
      })
    );

    var reuse = h(
      "button",
      {
        class: "result-meta__action",
        type: "button",
        "aria-label": "Use this result as the source for the next edit"
      },
      createIcon("layer"),
      h("span", { text: "Use as source" })
    );

    reuse.addEventListener("click", function () {
      void addResultAttachment(result);
    });

    meta.append(reuse);
    figure.append(frame, meta);
    return figure;
  }

  function buildErrorCard(message, onRetry) {
    var card = h("div", { class: "error-card", role: "alert" });

    card.append(
      h(
        "span",
        { class: "error-card__icon", "aria-hidden": "true" },
        createIcon("alert")
      )
    );

    var copy = h("div", { class: "error-card__copy" });
    copy.append(
      h("strong", { text: "The render didn’t complete" }),
      document.createTextNode(message)
    );

    if (typeof onRetry === "function") {
      var retry = h("button", {
        class: "error-card__action",
        type: "button",
        text: "Try again"
      });
      retry.addEventListener("click", onRetry);
      copy.append(retry);
    }

    card.append(copy);
    return card;
  }

  /* ------------------------------------------------------------------------
     Turn orchestration
     ------------------------------------------------------------------------ */

  function pickSource(attachments) {
    var results = attachments.filter(function (attachment) {
      return attachment.origin === "result";
    });

    if (results.length) {
      return results[results.length - 1];
    }

    return attachments[attachments.length - 1];
  }

  function buildFilename(styleId) {
    state.renderCount += 1;
    var stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return (
      "bigmix-" +
      styleId +
      "-" +
      stamp +
      "-" +
      String(state.renderCount).padStart(2, "0") +
      ".jpg"
    );
  }

  function beginWorking(request, source, style) {
    var article = h("article", { class: "message message--assistant" });
    article.append(buildAssistantHead(new Date()));

    var orb = h("span", { class: "working__orb", "aria-hidden": "true" });
    var title = h("p", {
      class: "working__title",
      text: WORKING_STAGES[0]
    });
    var detail = h("p", {
      class: "working__detail",
      text:
        style.label +
        " · " +
        (source.width || 0) +
        " × " +
        (source.height || 0) +
        " · preserving composition"
    });
    var copy = h(
      "div",
      { class: "working__copy" },
      title,
      detail
    );
    var time = h("span", { class: "working__time", text: "0.0s" });

    var working = h(
      "div",
      {
        class: "working",
        role: "status",
        "aria-live": "polite",
        "aria-label": "Rendering the edit"
      },
      orb,
      copy,
      time
    );

    article.append(working);
    mountMessage(article, { forceScroll: true, smooth: true });

    var startedAt = performance.now();
    var stage = 0;
    var lastStageFlip = startedAt;

    var timer = window.setInterval(function () {
      var elapsed = (performance.now() - startedAt) / 1000;
      time.textContent = elapsed.toFixed(1) + "s";

      if (performance.now() - lastStageFlip > 3000) {
        stage = (stage + 1) % WORKING_STAGES.length;
        title.textContent = WORKING_STAGES[stage];
        lastStageFlip = performance.now();
      }
    }, 110);

    var job = {
      article: article,
      working: working,
      timer: timer,
      request: request
    };

    activeJobs.add(job);
    return job;
  }

  function cleanupJob(job) {
    if (!job) {
      return;
    }
    if (job.timer) {
      window.clearInterval(job.timer);
      job.timer = 0;
    }
    activeJobs.delete(job);
  }

  function completeJob(job, payload) {
    cleanupJob(job);
    job.working.remove();

    var style = payload.style;
    var rendered = payload.rendered;
    var source = payload.source;
    var request = payload.request;

    var result = {
      id: uniqueId("render"),
      filename: buildFilename(style.id),
      src: rendered.src,
      width: rendered.width,
      height: rendered.height,
      styleId: style.id,
      styleLabel: style.label,
      sourceName: source.name,
      createdAt: new Date()
    };

    state.lastResult = result;
    state.lastStyleId = style.id;

    job.article.append(
      buildReply({
        style: style,
        request: request,
        result: result,
        source: source
      }),
      buildResultCard(result, style)
    );

    job.article.dataset.state = "done";
    updateClearButton();
    updateComposer();

    var card = job.article.querySelector(".result");
    var picture = card ? card.querySelector(".result__img") : null;

    if (picture && typeof picture.decode === "function") {
      picture
        .decode()
        .then(settleResultView)
        .catch(settleResultView);
    } else {
      settleResultView();
    }

    function settleResultView() {
      updateResultWidths();

      if (state.follow) {
        scrollToBottom({ force: true, smooth: true });
      } else {
        updateJump();
      }
    }
  }

  function failJob(job, request, error) {
    cleanupJob(job);
    job.working.remove();

    var restored = restoreAttachments(request.attachments);
    var detail =
      (error && error.message
        ? error.message
        : "Something interrupted the render.") +
      (restored
        ? " Your " +
          plural(restored, "image") +
          (restored === 1 ? " was" : " were") +
          " returned to the composer."
        : "");

    var card = buildErrorCard(detail, function () {
      if (state.busy) {
        return;
      }
      card.remove();
      void runEdit(request);
    });

    job.article.append(card);
    job.article.dataset.state = "error";
    updateComposer();

    if (nearBottom()) {
      scrollToBottom({ force: true });
    } else {
      updateJump();
    }
  }

  async function runEdit(request) {
    if (state.busy) {
      return;
    }

    var source =
      request.source ||
      (request.attachments.length ? pickSource(request.attachments) : null);

    if (!source) {
      toast("Attach an image to begin.", "error");
      return;
    }

    var style =
      request.style && STYLE_BY_ID.has(request.style.id)
        ? request.style
        : chooseStyle(request.text, state.lastStyleId).style;

    request.style = style;

    state.busy = true;
    var token = state.generation;
    var job = beginWorking(request, source, style);
    updateComposer();
    updateClearButton();

    var startedAt = performance.now();

    try {
      await sleep(isReducedMotion() ? 90 : 380);
      await nextFrame();

      if (token !== state.generation) {
        return;
      }

      var rendered = await renderEdit({
        source: source,
        style: style,
        prompt: request.text
      });

      var elapsed = performance.now() - startedAt;
      var minimum = isReducedMotion() ? 100 : MIN_RENDER_MS;

      if (elapsed < minimum) {
        await sleep(minimum - elapsed);
      }

      if (token !== state.generation) {
        return;
      }

      completeJob(job, {
        rendered: rendered,
        style: style,
        request: request,
        source: source
      });
    } catch (error) {
      if (token !== state.generation) {
        return;
      }
      failJob(job, request, error);
    } finally {
      if (token === state.generation) {
        state.busy = false;
        updateComposer();
        updateClearButton();
      }
    }
  }

  function handleSubmit(event) {
    if (event && typeof event.preventDefault === "function") {
      event.preventDefault();
    }

    if (state.busy) {
      toast("The current render is still finishing.", "info");
      return;
    }

    var text = refs.prompt.value.trim();
    var explicitAttachments = state.pending.slice();
    var implicit = false;
    var attachments = explicitAttachments;
    var source = null;

    if (!attachments.length) {
      if (!state.lastResult) {
        toast("Attach an image to begin.", "error");
        nudgeAttachButton();
        promptFocus();
        return;
      }
      implicit = true;
      source = {
        src: state.lastResult.src,
        width: state.lastResult.width,
        height: state.lastResult.height,
        name: state.lastResult.filename,
        key: "result:" + state.lastResult.id,
        origin: "result"
      };
    } else {
      source = pickSource(attachments);
    }

    if (!text && !explicitAttachments.length && !implicit) {
      return;
    }

    var chosen = chooseStyle(text, state.lastStyleId);

    if (text || !implicit) {
      appendUserMessage({ text: text, attachments: attachments });
    }

    refs.prompt.value = "";
    state.pending = [];
    renderAttachmentRow();
    updateComposer();
    autoGrowPrompt();

    var request = {
      text: text,
      attachments: attachments,
      implicit: implicit,
      source: source,
      style: chosen.style,
      autoStyle: chosen.auto
    };

    void runEdit(request);
  }

  /* ------------------------------------------------------------------------
     Clear conversation
     ------------------------------------------------------------------------ */

  function clearConversation() {
    state.generation += 1;
    state.busy = false;

    activeJobs.forEach(function (job) {
      cleanupJob(job);
    });
    activeJobs.clear();

    state.pending = [];
    state.lastResult = null;
    state.lastStyleId = null;
    state.renderCount = 0;
    state.follow = true;
    resultAttachmentCache.clear();

    refs.messages.replaceChildren();
    refs.empty.hidden = false;
    refs.prompt.value = "";
    setMenu(false);

    renderAttachmentRow();
    updateComposer();
    updateClearButton();
    updateJump();

    refs.thread.scrollTo({ top: 0, behavior: "auto" });
    toast("Conversation cleared.", "ok");
  }

  function requestClear() {
    if (refs.messages.childElementCount === 0) {
      return;
    }

    clearReturnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    if (typeof refs.clearDialog.showModal === "function") {
      refs.clearDialog.returnValue = "";
      refs.clearDialog.showModal();
    } else if (
      window.confirm(
        "Clear this conversation? Every message, attachment and rendered result will be removed from this tab."
      )
    ) {
      clearConversation();
    }
  }

  function bindDialog() {
    if (!refs.clearDialog) {
      return;
    }

    refs.clearDialog.addEventListener("close", function () {
      var confirmed = refs.clearDialog.returnValue === "confirm";
      if (confirmed) {
        clearConversation();
      }
      if (clearReturnFocus && clearReturnFocus.isConnected) {
        clearReturnFocus.focus({ preventScroll: true });
      }
      clearReturnFocus = null;
    });

    refs.clearDialog.addEventListener("click", function (event) {
      if (event.target === refs.clearDialog) {
        refs.clearDialog.close("cancel");
      }
    });
  }

  /* ------------------------------------------------------------------------
     Lightbox
     ------------------------------------------------------------------------ */

  function openLightbox(record) {
    if (!record || !record.src) {
      return;
    }

    window.clearTimeout(lightboxState.hideTimer);
    lightboxState.record = record;
    lightboxState.lastFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    refs.lightboxImage.src = record.src;
    refs.lightboxImage.alt = record.alt || record.title || "Image";
    refs.lightboxTitle.textContent = record.title || "Image";
    refs.lightboxMeta.textContent = record.meta || "";
    refs.lightboxEdit.hidden = typeof record.onEdit !== "function";

    refs.lightbox.hidden = false;
    refs.lightbox.setAttribute("aria-hidden", "false");
    document.body.classList.add("has-lightbox");
    lightboxState.open = true;

    window.requestAnimationFrame(function () {
      if (!lightboxState.open) {
        return;
      }
      refs.lightbox.classList.add("is-open");
    });

    try {
      refs.lightboxClose.focus({ preventScroll: true });
    } catch (error) {
      refs.lightboxClose.focus();
    }
  }

  function closeLightbox() {
    if (!lightboxState.open) {
      return;
    }

    lightboxState.open = false;
    lightboxState.record = null;

    refs.lightbox.classList.remove("is-open");
    refs.lightbox.setAttribute("aria-hidden", "true");
    document.body.classList.remove("has-lightbox");

    var restore = lightboxState.lastFocus;
    lightboxState.lastFocus = null;

    if (restore && restore.isConnected && typeof restore.focus === "function") {
      try {
        restore.focus({ preventScroll: true });
      } catch (error) {
        restore.focus();
      }
    }

    window.clearTimeout(lightboxState.hideTimer);
    lightboxState.hideTimer = window.setTimeout(
      function () {
        if (!lightboxState.open) {
          refs.lightbox.hidden = true;
          refs.lightboxImage.removeAttribute("src");
        }
      },
      isReducedMotion() ? 0 : 260
    );
  }

  function bindLightbox() {
    refs.lightbox.addEventListener("keydown", function (event) {
      if (event.key !== "Tab") {
        return;
      }

      var nodes = Array.prototype.slice
        .call(refs.lightbox.querySelectorAll("button"))
        .filter(function (element) {
          return (
            !element.disabled &&
            !element.hidden &&
            element.getClientRects().length > 0
          );
        });

      if (!nodes.length) {
        return;
      }

      var first = nodes[0];
      var last = nodes[nodes.length - 1];
      var active = document.activeElement;

      if (event.shiftKey) {
        if (active === first || !refs.lightbox.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !refs.lightbox.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    });

    refs.lightboxClose.addEventListener("click", closeLightbox);
    refs.lightboxScrim.addEventListener("click", closeLightbox);

    refs.lightboxDownload.addEventListener("click", function () {
      var record = lightboxState.record;
      if (!record) {
        return;
      }
      void downloadImage(record.src, record.downloadName || record.title);
    });

    refs.lightboxEdit.addEventListener("click", function () {
      var record = lightboxState.record;
      if (!record || typeof record.onEdit !== "function") {
        return;
      }

      var action = record.onEdit;
      closeLightbox();

      Promise.resolve()
        .then(function () {
          return action();
        })
        .catch(function () {
          toast("That image could not be attached.", "error");
        });
    });
  }

  /* ------------------------------------------------------------------------
     Keyboard
     ------------------------------------------------------------------------ */

  function onPromptKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    if (event.isComposing || event.keyCode === 229) {
      return;
    }

    event.preventDefault();

    if (state.busy) {
      toast("The current render is still finishing.", "info");
      return;
    }

    if (typeof refs.composer.requestSubmit === "function") {
      refs.composer.requestSubmit();
    } else {
      refs.composer.dispatchEvent(
        new Event("submit", { cancelable: true, bubbles: true })
      );
    }
  }

  function onGlobalKeyDown(event) {
    if (event.key === "Escape") {
      if (state.menuOpen) {
        event.preventDefault();
        setMenu(false, { focusTrigger: true });
        return;
      }
      if (lightboxState.open) {
        event.preventDefault();
        closeLightbox();
      }
      return;
    }

    if (!state.menuOpen) {
      return;
    }

    var navigationKeys = ["ArrowDown", "ArrowUp", "Home", "End"];

    if (navigationKeys.indexOf(event.key) !== -1) {
      event.preventDefault();

      var nodes = Array.prototype.slice
        .call(refs.attachMenu.querySelectorAll(".menu-item:not(:disabled)"));

      if (!nodes.length) {
        return;
      }

      var index = nodes.indexOf(document.activeElement);
      var next = 0;

      if (event.key === "ArrowDown") {
        next = index < 0 ? 0 : (index + 1) % nodes.length;
      } else if (event.key === "ArrowUp") {
        next = index <= 0 ? nodes.length - 1 : index - 1;
      } else if (event.key === "End") {
        next = nodes.length - 1;
      }

      nodes[next].focus();
      return;
    }

    if (event.key === "Tab") {
      setMenu(false);
    }
  }

  /* ------------------------------------------------------------------------
     Event wiring
     ------------------------------------------------------------------------ */

  function bindComposer() {
    refs.composer.addEventListener("submit", handleSubmit);
    refs.prompt.addEventListener("input", function () {
      updateComposer();
    });
    refs.prompt.addEventListener("keydown", onPromptKeyDown);

    refs.attachButton.addEventListener("click", function (event) {
      event.stopPropagation();
      setMenu(!state.menuOpen, { keyboard: event.detail === 0 });
    });

    refs.attachMenu.addEventListener("click", function (event) {
      if (!(event.target instanceof Element)) {
        return;
      }

      var item = event.target.closest("[data-action]");
      if (!item) {
        return;
      }

      var action = item.getAttribute("data-action");

      if (action === "choose") {
        setMenu(false);
        openFilePicker();
      } else if (action === "last") {
        setMenu(false);
        if (state.lastResult) {
          void addResultAttachment(state.lastResult);
        }
      } else if (action === "clear") {
        setMenu(false);
        clearPendingAttachments();
      }
    });

    refs.fileInput.addEventListener("change", function (event) {
      // Copy the FileList first: resetting the input clears it in every engine,
      // and we reset so choosing the same file twice still fires a change.
      var files = Array.prototype.slice.call(
        (event.target && event.target.files) || []
      );
      event.target.value = "";

      if (files.length) {
        void intakeFiles(files);
      }
    });

    refs.emptyChoose.addEventListener("click", openFilePicker);
    refs.emptySample.addEventListener("click", function () {
      void addSample();
    });

    suggestions.forEach(function (button) {
      button.addEventListener("click", function () {
        var text = button.getAttribute("data-prompt") || "";
        refs.prompt.value = text;
        updateComposer();

        if (!state.pending.length && !state.lastResult) {
          toast("Add an image and this note is ready to send.", "info");
          nudgeAttachButton();
          promptFocus();
        } else {
          promptFocus();
        }
      });
    });

    refs.jump.addEventListener("click", function () {
      scrollToBottom({ force: true, smooth: true });
    });

    refs.clearButton.addEventListener("click", requestClear);

    refs.thread.addEventListener(
      "scroll",
      function () {
        state.follow = nearBottom();
        updateJump();
      },
      { passive: true }
    );

    document.addEventListener("pointerdown", function (event) {
      if (!state.menuOpen) {
        return;
      }

      var target = event.target;

      if (
        target instanceof Node &&
        (refs.attachMenu.contains(target) ||
          refs.attachButton.contains(target))
      ) {
        return;
      }

      setMenu(false);
    });

    document.addEventListener("keydown", onGlobalKeyDown);

    window.addEventListener("resize", function () {
      if (resizeFrame) {
        return;
      }
      resizeFrame = window.requestAnimationFrame(function () {
        resizeFrame = 0;
        updateResultWidths();
        autoGrowPrompt();
      });
    });
  }

  /* ------------------------------------------------------------------------
     Boot
     ------------------------------------------------------------------------ */

  function boot() {
    if (!refs.stage || !refs.messages || !refs.composer) {
      if (window.console && typeof window.console.error === "function") {
        window.console.error("Bigmix Studio could not find its mount points.");
      }
      return;
    }

    bindComposer();
    bindLightbox();
    bindDialog();
    bindDragAndDrop();

    renderAttachmentRow();
    updateComposer();
    updateClearButton();
    updateJump();
    updateResultWidths();

    refs.lightbox.hidden = true;
    refs.lightbox.setAttribute("aria-hidden", "true");
    refs.empty.hidden = false;

    if (refs.clearDialog && typeof refs.clearDialog.showModal !== "function") {
      refs.clearButton.setAttribute(
        "title",
        "Clear conversation (confirmation dialog unsupported)"
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  /* A tiny debug surface — handy in the console, harmless in production. */
  window.BigmixStudio = {
    styles: STYLES.map(function (style) {
      return { id: style.id, label: style.label };
    }),
    classify: function (text) {
      var match = chooseStyle(text, null);
      return {
        id: match.style.id,
        label: match.style.label,
        inferred: match.auto
      };
    },
    getState: function () {
      return {
        pending: state.pending.length,
        busy: state.busy,
        hasResult: Boolean(state.lastResult),
        messages: refs.messages ? refs.messages.childElementCount : 0
      };
    }
  };
})();
