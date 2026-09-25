import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { convertPdfToPlt } from "./src/converter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
const CONVERTED_DIR = path.join(__dirname, "converted");
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EXTERNAL_TIMEOUT_MS = 30_000;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

await fs.mkdir(UPLOAD_DIR, { recursive: true });
await fs.mkdir(CONVERTED_DIR, { recursive: true });

const app = express();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const base = path.basename(file.originalname, path.extname(file.originalname))
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 80) || "arquivo";
    cb(null, base + "-" + crypto.randomUUID() + ".pdf");
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const extensionOk = path.extname(file.originalname).toLowerCase() === ".pdf";
    const mimeOk = [
      "application/pdf",
      "application/x-pdf",
      "application/octet-stream"
    ].includes(file.mimetype);

    if (!extensionOk || !mimeOk) {
      cb(new Error("Apenas arquivos PDF são aceitos."));
      return;
    }

    cb(null, true);
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.post("/convert", upload.single("pdf"), async (req, res) => {
  const inputPath = req.file?.path;

  if (!inputPath) {
    res.status(400).json({ success: false, error: "Nenhum PDF foi enviado." });
    return;
  }

  console.log("[PDF] arquivo recebido: " + req.file.originalname);
  console.log("[PDF] tamanho: " + formatBytes(req.file.size));

  try {
    const outputName =
      path.basename(req.file.filename, ".pdf") + ".plt";
    const outputPath = path.join(CONVERTED_DIR, outputName);

    console.log("[CONVERTER] iniciando extração vetorial");
    const result = await convertPdfToPlt(inputPath, outputPath);

    console.log("[CONVERTER] paths encontrados: " + result.geometry.paths);
    console.log("[CONVERTER] segmentos: " + result.geometry.segments);
    console.log("[CONVERTER] curvas: " + result.geometry.curves);
    console.log("[GEOMETRY] width: " + result.dimensions.widthMm.toFixed(2) + " mm");
    console.log("[GEOMETRY] height: " + result.dimensions.heightMm.toFixed(2) + " mm");
    console.log("[HPGL] units/mm: " + result.scale.hpglUnitsPerMm);
    console.log("[HPGL] output: converted/" + outputName);
    console.log("[OK] conversão concluída");

    res.json({
      success: true,
      file: outputName,
      dimensions: {
        widthMm: Number(result.dimensions.widthMm.toFixed(4)),
        heightMm: Number(result.dimensions.heightMm.toFixed(4))
      },
      geometry: result.geometry,
      boundingBoxPt: result.boundingBoxPt,
      scale: result.scale,
      downloadUrl: "/download/" + encodeURIComponent(outputName)
    });
  } catch (error) {
    console.error("[ERROR] Falha na conversão:", error);
    res.status(422).json({
      success: false,
      error: error?.message || "Falha na conversão."
    });
  } finally {
    await safeUnlink(inputPath);
  }
});

app.get("/download/:filename", async (req, res) => {
  const filename = path.basename(req.params.filename);

  if (!filename.toLowerCase().endsWith(".plt")) {
    res.status(400).send("Arquivo inválido.");
    return;
  }

  const filePath = path.join(CONVERTED_DIR, filename);

  try {
    await fs.access(filePath);
    res.download(filePath, filename);
  } catch {
    res.status(404).send("Arquivo PLT não encontrado.");
  }
});

app.use((error, _req, res, _next) => {
  console.error("[ERROR]", error);

  if (error instanceof multer.MulterError &&
      error.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({
      success: false,
      error: "O PDF excede o limite de 25 MB."
    });
    return;
  }

  res.status(400).json({
    success: false,
    error: error?.message || "Erro inesperado."
  });
});

app.listen(PORT, () => {
  console.log("[SERVER] PDF → PLT em http://localhost:" + PORT);
});

setInterval(() => {
  cleanupOldFiles(CONVERTED_DIR).catch(error =>
    console.error("[CLEANUP] erro:", error)
  );
}, 60 * 60 * 1000).unref();

async function cleanupOldFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const now = Date.now();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".plt")) {
      continue;
    }

    const filePath = path.join(directory, entry.name);
    const stat = await fs.stat(filePath);

    if (now - stat.mtimeMs > MAX_AGE_MS) {
      await safeUnlink(filePath);
      console.log("[CLEANUP] removido: converted/" + entry.name);
    }
  }
}

async function safeUnlink(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("[CLEANUP] erro ao remover " + filePath + ":", error);
    }
  }
}

// Helper para futuras ferramentas externas. Usa spawn sem shell.
// O pipeline atual não depende do UniConvertor.
export function runExternalCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      ...options
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(
        "Comando externo excedeu " + EXTERNAL_TIMEOUT_MS + " ms."
      ));
    }, EXTERNAL_TIMEOUT_MS);

    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr?.on("data", chunk => { stderr += chunk; });

    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", code => {
      clearTimeout(timer);

      if (code !== 0) {
        reject(new Error(
          "Comando externo terminou com código " + code + ". " +
          (stderr || stdout)
        ));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}
