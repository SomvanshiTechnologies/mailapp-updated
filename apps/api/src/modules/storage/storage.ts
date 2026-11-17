import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { AppConfig } from "../../config.js";

export interface Storage {
  driver: "local" | "s3";
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Read an object from an arbitrary bucket (the SES inbound bucket). Local mode emulates buckets as sub-folders of `_buckets/`. */
  getFromBucket(bucket: string, key: string): Promise<Buffer>;
}

/** Resolve `key` under `root`, refusing anything that escapes it. */
function safeJoin(root: string, ...parts: string[]): string {
  const base = path.resolve(root);
  const full = path.resolve(base, ...parts);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error(`Invalid storage key: ${parts.join("/")}`);
  return full;
}

export class LocalStorage implements Storage {
  readonly driver = "local" as const;
  constructor(private readonly dir: string) {}

  async put(key: string, body: Buffer): Promise<void> {
    const file = safeJoin(this.dir, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }

  get(key: string): Promise<Buffer> {
    return readFile(safeJoin(this.dir, key));
  }

  getFromBucket(bucket: string, key: string): Promise<Buffer> {
    return readFile(safeJoin(this.dir, "_buckets", bucket, key));
  }
}

export class S3Storage implements Storage {
  readonly driver = "s3" as const;
  private readonly s3: S3Client;

  constructor(
    private readonly bucket: string,
    private readonly prefix: string,
    region: string,
  ) {
    this.s3 = new S3Client({ region });
  }

  async put(key: string, body: Buffer, contentType?: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.prefix + key, Body: body, ContentType: contentType }));
  }

  get(key: string): Promise<Buffer> {
    return this.read(this.bucket, this.prefix + key);
  }

  getFromBucket(bucket: string, key: string): Promise<Buffer> {
    return this.read(bucket, key);
  }

  private async read(bucket: string, key: string): Promise<Buffer> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!res.Body) throw new Error(`Empty S3 object s3://${bucket}/${key}`);
    return Buffer.from(await res.Body.transformToByteArray());
  }
}

export function createStorage(config: AppConfig): Storage {
  if (config.STORAGE_DRIVER === "s3") {
    if (!config.STORAGE_S3_BUCKET) throw new Error("STORAGE_DRIVER=s3 requires STORAGE_S3_BUCKET");
    return new S3Storage(config.STORAGE_S3_BUCKET, config.STORAGE_S3_PREFIX, config.AWS_REGION);
  }
  return new LocalStorage(config.STORAGE_LOCAL_DIR);
}
