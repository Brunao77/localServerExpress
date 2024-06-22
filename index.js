const express = require("express");
const cors = require("cors");
const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");
const { uploadFile } = require("./controller.js");

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let ffmpegProcesses = {};
let ffmpegProcessesStream = {};

app.get("/", (req, res) => {
  console.log("Hello World!");
});

app.get("/start-record", async (request, response) => {
  console.log("START RECORD EXECUTE");
  const { camera_id, rtsp } = request.query;
  const now = new Date();
  const options = {
    timeZone: "America/Argentina/Buenos_Aires",
    hour12: false,
  };
  const formattedDate = new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...options,
  })
    .format(now)
    .split("/")
    .reverse()
    .join("-");

  const formattedTime = new Intl.DateTimeFormat("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    ...options,
  })
    .format(now)
    .replace(/:/g, "-")
    .slice(0, -3);
  const folderName = `${camera_id}a${formattedDate}a${formattedTime}`;
  const folderPath = path.join(__dirname, folderName);

  if (
    rtsp in ffmpegProcesses &&
    ffmpegProcesses[rtsp] &&
    ffmpegProcesses[rtsp].exitCode === null
  ) {
    await fetch(`http://localhost:3000/stop-record?rtsp=${rtsp}`);
  }

  if (!fs.existsSync(folderPath)) {
    fs.mkdir(folderPath, (error) => {
      if (error) {
        console.error("Error al crear la carpeta:", error);
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Error al crear la carpeta" }));
        return;
      }
      const filename = path.join(folderPath, `${folderName}a.m3u8`);
      //ffmpeg -i rtsp://admin:password123@192.168.0.64:554/Streaming/Channels/101 -i watermark.png -filter_complex "[1:v]scale=iw/4:ih/4[watermark];[0:v][watermark]overlay=W-w-10:H-h-10" -r 25 -c:v libx264 -preset fast -crf 30 -an -force_key_frames expr:gte(t,n_forced*40) -f hls -hls_time 40 -hls_list_size 0 -y index.m3u8
      const ffmpeg = spawn(
        "ffmpeg",
        [
          "-i",
          rtsp,
          "-i",
          "watermark.png",
          "-filter_complex",
          "[1:v]scale=iw/4:ih/4[watermark];[0:v][watermark]overlay=W-w-10:H-h-10",
          "-r",
          "25",
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          "30",
          "-an",
          "-force_key_frames",
          "expr:gte(t,n_forced*40)",
          "-f",
          "hls",
          "-hls_time",
          "40",
          "-hls_list_size",
          "0",
          "-y",
          filename,
        ],
        { windowsHide: true }
      );

      ffmpegProcesses[rtsp] = {
        process: ffmpeg,
        folderName,
        start_time: Date.now(),
      };

      ffmpeg.stdout.on("data", (data) => {
        console.log(`stdout:\n${data}`);
      });
      ffmpeg.stderr.on("data", (data) => {
        console.log(`stdout: ${data}`);
      });

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: "Transmisión HLS iniciada" }));
    });
  }
});

app.get("/stop-record", async (request, response) => {
  console.log("STOP RECORD EXECUTE");
  const { rtsp } = request.query;

  if (
    rtsp in ffmpegProcesses &&
    ffmpegProcesses[rtsp].process &&
    ffmpegProcesses[rtsp].process.exitCode === null
  ) {
    const endTime = new Date();
    ffmpegProcesses[rtsp].process.kill("SIGKILL");

    const res = await new Promise((resolve, reject) => {
      ffmpegProcesses[rtsp].process.on("exit", async () => {
        const { folderName } = ffmpegProcesses[rtsp];
        const folderPath = path.join(__dirname, folderName);

        fs.appendFileSync(
          `${path.join(folderPath, folderName)}a.m3u8`,
          "#EXT-X-ENDLIST\n"
        );

        const files = fs.readdirSync(folderPath);

        const promises = files.map(async (file) => {
          const filePath = path.join(folderPath, file);
          const s3Key = path.basename(filePath);
          await uploadFile(filePath, s3Key);
        });

        await Promise.all(promises);

        fs.rmSync(folderPath, { recursive: true, force: true });

        const data = folderName.split("a");
        const camera_id = data[0];
        const date = data[1];
        const start_time = data[2].replace(/-/g, ":");
        const end_time = endTime.toTimeString().slice(0, 5);
        const video_url = `${folderName}a.m3u8`;

        delete ffmpegProcesses[rtsp];

        try {
          const res = await fetch(
            "https://sportscamera.vercel.app/api/videos/uploadToDb",
            {
              method: "POST",
              headers: {
                Origin: "http://localhost:3000",
              },
              body: JSON.stringify({
                date,
                start_time,
                end_time,
                video_url,
                camera_id,
              }),
            }
          );

          if (res.ok) {
            resolve({ status: 200, start_time, end_time });
          } else {
            resolve({ status: 404 });
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    if (res.status === 200) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ start_time: res.start_time, end_time: res.end_time })
      );
    }
    if (res.status === 404) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ error: "No se pudo subir el video a la db" })
      );
    }
  }
});

app.get("/exist-record", (request, response) => {
  console.log("exist record");
  const { rtsp } = request.query;

  if (rtsp in ffmpegProcesses) {
    const responseBody = {
      exists: true,
      start_time: ffmpegProcesses[rtsp].start_time,
    };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(responseBody));
    return;
  } else {
    const responseBody = {
      exists: false,
    };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(responseBody));
  }
});

app.get("/get-thumbnail", (request, response) => {
  const { rtsp } = request.query;

  const ip = rtsp.match(/(\d{1,3}\.){3}\d{1,3}/)[0];
  console.log(ip);
  console.log(rtsp);
  //const ip = rtsp.match(/rtsp:\/\/admin:password123@([\d.]+):/)[1];
  const folderPath = path.join(__dirname, ip);

  fs.mkdir(folderPath, (error) => {
    const filePath = path.join(folderPath, "thumbnail.jpg");

    const ffmpeg = spawn(
      "ffmpeg",
      ["-y", "-i", rtsp, "-vframes", "1", filePath],
      { windowsHide: true }
    );

    ffmpeg.stdout.on("data", (data) => {
      console.log(`stdout:\n${data}`);
    });
    ffmpeg.stderr.on("data", (data) => {
      console.log(`stdout: ${data}`);
    });

    ffmpeg.on("close", () => {
      ffmpeg.kill("SIGKILL");
      response.writeHead(200, { "Content-Type": "image/jpg" });
      fs.createReadStream(filePath).pipe(response);
    });
  });
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
