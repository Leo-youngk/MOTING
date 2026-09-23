// 旧域名(yk2958374240.workers.dev)的部署配置改写。
// 那个账户没有 R2/D1 资源:删掉 binding,加 SYNC_UPSTREAM 指向主部署,
// /api/sync/* 会被 Worker 服务端反向代理到主部署,客户端始终同源,零改动。
import { readFile, writeFile } from "node:fs/promises";

const UPSTREAM = process.env.SYNC_UPSTREAM ?? "https://moting-reader.if5v.workers.dev";
const configPath = new URL("../dist/server/wrangler.json", import.meta.url);

const config = JSON.parse(await readFile(configPath, "utf8"));
delete config.d1_databases;
delete config.r2_buckets;
config.vars = { ...config.vars, SYNC_UPSTREAM: UPSTREAM };
await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
console.log(`Legacy config written: sync upstream = ${UPSTREAM}`);
