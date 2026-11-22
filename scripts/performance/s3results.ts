// Download or upload a result directory under an S3 prefix (s3://bucket/prefix/).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";

import { describeError, parseCli, requiredString, runScript, UsageError, withUsageErrors } from "./common.ts";
import type { Clients } from "./common.ts";

export function parseS3Prefix(uri: string): [string, string] {
  if (!uri.startsWith("s3://")) {
    throw new Error(`not an S3 URI: ${uri}`);
  }
  const rest = uri.slice("s3://".length);
  const slash = rest.indexOf("/");
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  const prefix = slash === -1 ? "" : rest.slice(slash + 1);
  if (!bucket || !prefix) {
    throw new Error(`S3 URI needs a bucket and a prefix: ${uri}`);
  }
  return [bucket, `${prefix.replace(/\/+$/, "")}/`];
}

export async function downloadPrefix(s3: S3Client, uri: string, destination: string): Promise<string[]> {
  const [bucket, prefix] = parseS3Prefix(uri);
  const target = resolve(destination);
  mkdirSync(target, { recursive: true });
  const downloaded: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const item of page.Contents ?? []) {
      const key = item.Key as string;
      const relative = key.slice(prefix.length);
      if (!relative || relative.endsWith("/")) {
        continue;
      }
      const local = resolve(target, relative);
      if (!local.startsWith(target + sep)) {
        throw new Error(`refusing to write outside the destination: ${key}`);
      }
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, await (object.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray());
      downloaded.push(relative);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return downloaded.sort();
}

function listFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1).split(sep).join("/"));
}

export async function uploadDirectory(s3: S3Client, source: string, uri: string): Promise<string[]> {
  const [bucket, prefix] = parseS3Prefix(uri);
  const root = resolve(source);
  const uploaded: string[] = [];
  for (const relative of listFiles(root).sort()) {
    await s3.send(
      new PutObjectCommand({ Bucket: bucket, Key: prefix + relative, Body: readFileSync(join(root, relative)) }),
    );
    uploaded.push(relative);
  }
  return uploaded;
}

export async function main(argv: string[], clients: Clients): Promise<number> {
  return withUsageErrors(async () => {
    const [command, ...rest] = argv;
    let transfer: () => Promise<string[]>;
    if (command === "download") {
      const args = parseCli(rest, { prefix: requiredString, dest: requiredString });
      transfer = () => downloadPrefix(clients.s3, args.prefix, args.dest);
    } else if (command === "upload") {
      const args = parseCli(rest, { prefix: requiredString, src: requiredString });
      transfer = () => uploadDirectory(clients.s3, args.src, args.prefix);
    } else {
      throw new UsageError("expected a command: download or upload");
    }
    let files: string[];
    try {
      files = await transfer();
    } catch (exc) {
      process.stderr.write(`ERROR: ${describeError(exc)}\n`);
      return 2;
    }
    console.log(`${command}: ${files.length} file(s)`);
    return 0;
  });
}

if (import.meta.main) {
  await runScript(main);
}
