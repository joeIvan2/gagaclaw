const fs = require("fs");
const path = require("path");
const https = require("https");
const FormData = require("form-data");

const configPath = "c:\\py\\anti\\gagaclaw.json";
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const tgToken = config.telegram?.token;
const tgChatId = config.telegram?.adminChatId || (config.telegram?.allowedUsers || [])[0];

const absoluteFilePath = "c:\\py\\anti\\workspace\\crypto_capital_report.html";
let fileName = path.basename(absoluteFilePath);
let fileData = fs.readFileSync(absoluteFilePath);

const formData = new FormData();
formData.append("chat_id", tgChatId);
formData.append("document", fileData, { filename: fileName });

const req = https.request({
    hostname: "api.telegram.org",
    path: `/bot${tgToken}/sendDocument`,
    method: "POST",
    headers: formData.getHeaders()
}, res => {
    let data = "";
    res.on("data", c => data += c);
    res.on("end", () => {
        console.log("Response:", data);
    });
});
req.on('error', (e) => {
    console.error(e);
});
formData.pipe(req);
