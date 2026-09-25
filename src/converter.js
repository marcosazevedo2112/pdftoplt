import fs from "node:fs/promises";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

const PDF_POINTS_TO_MM = 25.4 / 72;
const HPGL_UNITS_PER_MM = Number(process.env.HPGL_UNITS_PER_MM) > 0
  ? Number(process.env.HPGL_UNITS_PER_MM)
  : 40;
const CURVE_TOLERANCE_MM = Number(process.env.CURVE_TOLERANCE_MM) > 0
  ? Number(process.env.CURVE_TOLERANCE_MM)
  : 0.01;
const IDENTITY = [1, 0, 0, 1, 0, 0];

function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ];
}

function point(matrix, x, y) {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5]
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointLineDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
    return distance(p, a);
  }

  return Math.abs(
    dy * p.x - dx * p.y + b.x * a.y - b.y * a.x
  ) / Math.hypot(dx, dy);
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function splitCubic(c) {
  const p01 = midpoint(c.p0, c.p1);
  const p12 = midpoint(c.p1, c.p2);
  const p23 = midpoint(c.p2, c.p3);
  const p012 = midpoint(p01, p12);
  const p123 = midpoint(p12, p23);
  const p0123 = midpoint(p012, p123);

  return [
    { p0: c.p0, p1: p01, p2: p012, p3: p0123 },
    { p0: p0123, p1: p123, p2: p23, p3: c.p3 }
  ];
}

function flattenCubic(cubic, tolerance, maxDepth = 18) {
  const points = [cubic.p0];

  function recurse(c, depth) {
    const flat = Math.max(
      pointLineDistance(c.p1, c.p0, c.p3),
      pointLineDistance(c.p2, c.p0, c.p3)
    );

    if (depth >= maxDepth || flat <= tolerance) {
      points.push(c.p3);
      return;
    }

    const parts = splitCubic(c);
    recurse(parts[0], depth + 1);
    recurse(parts[1], depth + 1);
  }

  recurse(cubic, 0);
  return points;
}

function addLine(path, from, to) {
  if (from && to) path.push({ type: "line", from, to });
}

function addCubic(path, p0, p1, p2, p3) {
  if (p0 && p1 && p2 && p3) {
    path.push({ type: "cubic", p0, p1, p2, p3 });
  }
}

function isPaint(op) {
  return op === OPS.stroke ||
    op === OPS.closeStroke ||
    op === OPS.fill ||
    op === OPS.eoFill ||
    op === OPS.fillStroke ||
    op === OPS.eoFillStroke ||
    op === OPS.closeFillStroke ||
    op === OPS.closeEOFillStroke;
}

function parseConstructPath(path, ops, args, matrix, state) {
  let j = 0;
  let current = state.current;

  for (const op of ops) {
    switch (op | 0) {
      case OPS.rectangle: {
        const x = args[j++];
        const y = args[j++];
        const w = args[j++];
        const h = args[j++];
        const p0 = point(matrix, x, y);
        const p1 = point(matrix, x + w, y);
        const p2 = point(matrix, x + w, y + h);
        const p3 = point(matrix, x, y + h);
        addLine(path, p0, p1);
        addLine(path, p1, p2);
        addLine(path, p2, p3);
        addLine(path, p3, p0);
        current = p0;
        state.subpath = p0;
        break;
      }

      case OPS.moveTo:
        current = point(matrix, args[j++], args[j++]);
        state.subpath = current;
        break;

      case OPS.lineTo: {
        const p = point(matrix, args[j++], args[j++]);
        addLine(path, current, p);
        current = p;
        break;
      }

      case OPS.curveTo: {
        const p1 = point(matrix, args[j++], args[j++]);
        const p2 = point(matrix, args[j++], args[j++]);
        const p3 = point(matrix, args[j++], args[j++]);
        addCubic(path, current, p1, p2, p3);
        current = p3;
        break;
      }

      case OPS.curveTo2: {
        const p2 = point(matrix, args[j++], args[j++]);
        const p3 = point(matrix, args[j++], args[j++]);
        addCubic(path, current, current, p2, p3);
        current = p3;
        break;
      }

      case OPS.curveTo3: {
        const p1 = point(matrix, args[j++], args[j++]);
        const p3 = point(matrix, args[j++], args[j++]);
        addCubic(path, current, p1, p3, p3);
        current = p3;
        break;
      }

      case OPS.closePath:
        if (current && state.subpath) {
          addLine(path, current, state.subpath);
          current = state.subpath;
        }
        break;

      default:
        throw new Error("Operador de caminho PDF não suportado: " + op);
    }

    state.current = current;
  }
}

function getBounds(paths) {
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity
  };

  for (const path of paths) {
    for (const s of path) {
      const pts = s.type === "line"
        ? [s.from, s.to]
        : [s.p0, s.p1, s.p2, s.p3];

      for (const p of pts) {
        bounds.minX = Math.min(bounds.minX, p.x);
        bounds.minY = Math.min(bounds.minY, p.y);
        bounds.maxX = Math.max(bounds.maxX, p.x);
        bounds.maxY = Math.max(bounds.maxY, p.y);
      }
    }
  }

  return bounds;
}

function hpglPoint(p, bounds) {
  return {
    x: Math.round((p.x - bounds.minX) * PDF_POINTS_TO_MM * HPGL_UNITS_PER_MM),
    y: Math.round((bounds.maxY - p.y) * PDF_POINTS_TO_MM * HPGL_UNITS_PER_MM)
  };
}

function generateHpgl(paths, bounds) {
  const lines = ["IN;", "PA;", "SP1;"];
  let outputSegments = 0;

  for (const path of paths) {
    if (!path.length) continue;

    const first = path[0].type === "line" ? path[0].from : path[0].p0;
    let current = hpglPoint(first, bounds);

    lines.push("PU" + current.x + "," + current.y + ";");

    for (const segment of path) {
      if (segment.type === "line") {
        const from = hpglPoint(segment.from, bounds);
        const to = hpglPoint(segment.to, bounds);

        if (from.x !== current.x || from.y !== current.y) {
          lines.push("PU" + from.x + "," + from.y + ";");
        }

        lines.push("PD" + to.x + "," + to.y + ";");
        current = to;
        outputSegments++;
        continue;
      }

      const curve = {
        p0: hpglPoint(segment.p0, bounds),
        p1: hpglPoint(segment.p1, bounds),
        p2: hpglPoint(segment.p2, bounds),
        p3: hpglPoint(segment.p3, bounds)
      };

      const points = flattenCubic(
        curve,
        CURVE_TOLERANCE_MM * HPGL_UNITS_PER_MM
      );

      for (let i = 1; i < points.length; i++) {
        const p = points[i];
        lines.push("PD" + p.x + "," + p.y + ";");
        current = p;
        outputSegments++;
      }
    }

    lines.push("PU;");
  }

  lines.push("SP0;");
  return {
    hpgl: lines.join("\n") + "\n",
    outputSegments
  };
}

export async function convertPdfToPlt(inputPath, outputPath) {
  const data = new Uint8Array(await fs.readFile(inputPath));
  const loadingTask = getDocument({
    data,
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false
  });

  const pdf = await loadingTask.promise;

  try {
    if (pdf.numPages !== 1) {
      throw new Error(
        "A POC aceita apenas PDF de uma página. O arquivo possui " +
        pdf.numPages + " páginas."
      );
    }

    const page = await pdf.getPage(1);
    const operatorList = await page.getOperatorList();

    const paths = [];
    let currentPath = [];
    let matrix = [...IDENTITY];
    const stack = [];
    const state = { current: null, subpath: null };

    function finalize() {
      if (currentPath.length) {
        paths.push(currentPath);
      }
      currentPath = [];
      state.current = null;
      state.subpath = null;
    }

    for (let i = 0; i < operatorList.fnArray.length; i++) {
      const op = operatorList.fnArray[i];
      const args = operatorList.argsArray[i] || [];

      if (op === OPS.save) {
        stack.push({
          matrix: [...matrix],
          current: state.current,
          subpath: state.subpath
        });
        continue;
      }

      if (op === OPS.restore) {
        const saved = stack.pop();
        if (saved) {
          matrix = saved.matrix;
          state.current = saved.current;
          state.subpath = saved.subpath;
        }
        continue;
      }

      if (op === OPS.transform) {
        matrix = multiply(matrix, args);
        continue;
      }

      if (op === OPS.constructPath) {
        parseConstructPath(
          currentPath,
          args[0] || [],
          args[1] || [],
          matrix,
          state
        );
        continue;
      }

      if (op === OPS.closePath) {
        if (state.current && state.subpath) {
          addLine(currentPath, state.current, state.subpath);
          state.current = state.subpath;
        }
        continue;
      }

      if (isPaint(op) || op === OPS.endPath) {
        finalize();
      }
    }

    finalize();

    if (!paths.length) {
      throw new Error(
        "Nenhuma geometria vetorial de caminho foi encontrada. " +
        "O PDF precisa conter paths de corte; imagem raster e texto simples não são convertidos."
      );
    }

    const bounds = getBounds(paths);
    const widthPt = bounds.maxX - bounds.minX;
    const heightPt = bounds.maxY - bounds.minY;
    const viewport = page.getViewport({ scale: 1 });
    const userUnit = Number(page.userUnit) || 1;

    const curves = paths.reduce(
      (n, p) => n + p.filter(s => s.type === "cubic").length,
      0
    );
    const segments = paths.reduce((n, p) => n + p.length, 0);

    const generated = generateHpgl(paths, bounds);
    await fs.writeFile(outputPath, generated.hpgl, "ascii");
    await page.cleanup();

    return {
      dimensions: {
        widthMm: widthPt * PDF_POINTS_TO_MM,
        heightMm: heightPt * PDF_POINTS_TO_MM
      },
      geometry: {
        paths: paths.length,
        segments,
        curves,
        outputSegments: generated.outputSegments
      },
      boundingBoxPt: bounds,
      page: {
        widthPt: viewport.width * userUnit,
        heightPt: viewport.height * userUnit,
        userUnit
      },
      scale: {
        ratio: "1:1",
        pdfPointsPerInch: 72,
        mmPerInch: 25.4,
        hpglUnitsPerMm: HPGL_UNITS_PER_MM,
        curveToleranceMm: CURVE_TOLERANCE_MM
      }
    };
  } finally {
    await loadingTask.destroy();
  }
}
