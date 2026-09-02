import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';

import { badRequest, payloadTooLarge } from '../errors.js';

let defaultMaxBodyBytes = 10 * 1024 * 1024;
let defaultMaxFieldBytes = 1024 * 1024;
let defaultMaxFiles = 100;
let defaultMaxFields = 1000;

function appendValue(object, name, value) {
  if (!Object.hasOwn(object, name)) {
    object[name] = value;
    return;
  }

  object[name] = Array.isArray(object[name])
    ? [...object[name], value]
    : [object[name], value];
}

function normalizeMultipartError(error) {
  if (error?.code === 'PAYLOAD_TOO_LARGE') return error;
  return badRequest(error?.message || 'Invalid multipart request body');
}

function drainRequest(request) {
  if (!request.destroyed) request.resume();
}

/**
 * Parse a bounded multipart request into plain fields and temporary files.
 *
 * The returned cleanup function owns the temporary directory and must run
 * after the endpoint finishes using the files.
 */
export async function parseMultipartBody(request, {
  maxBytes = defaultMaxBodyBytes,
  maxFieldBytes = defaultMaxFieldBytes,
  maxFiles = defaultMaxFiles,
  maxFields = defaultMaxFields,
  maxParts = maxFiles + maxFields,
  maxFileBytes = maxBytes,
  tempDir = os.tmpdir()
} = {}) {
  let parser;

  try {
    parser = Busboy({
      headers: request.headers,
      limits: {
        fieldSize: maxFieldBytes,
        fields: maxFields,
        files: maxFiles,
        parts: maxParts,
        fileSize: maxFileBytes
      }
    });
  } catch (error) {
    drainRequest(request);
    throw normalizeMultipartError(error);
  }

  let directory = await mkdtemp(path.join(tempDir, 'cricket-upload-'));
  let body = {};
  let files = [];
  let fileWrites = [];
  let fileStreams = new Set();
  let totalBytes = 0;
  let settled = false;
  let failure = null;
  let failureCleanupPromise = null;

  let cleanup = async () => {
    await rm(directory, { recursive: true, force: true });
  };

  let result = await new Promise((resolve, reject) => {
    let rejectAfterCleanup = async () => {
      if (!failure || settled) return;
      if (failureCleanupPromise) return await failureCleanupPromise;

      settled = true;
      request.unpipe(parser);
      for (let stream of fileStreams)
        stream.destroy(failure);
      parser.destroy();
      drainRequest(request);

      failureCleanupPromise = (async () => {
        await Promise.allSettled(fileWrites);
        await cleanup().catch(() => {});
        reject(failure);
      })();

      await failureCleanupPromise;
    };

    let rejectOnce = error => {
      if (failure || settled) return;
      failure = normalizeMultipartError(error);
      void rejectAfterCleanup();
    }

    request.on('data', chunk => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        rejectOnce(payloadTooLarge(`Request body exceeds ${maxBytes} bytes`, { maxBytes }));
      }
    });
    request.on('aborted', () => {
      rejectOnce(badRequest('Request aborted'));
    });
    request.on('close', () => {
      if (!request.complete) {
        rejectOnce(badRequest('Request closed before the body was complete'));
      }
    });
    request.on('error', error => {
      rejectOnce(error);
    });

    parser.on('field', (name, value, info) => {
      if (info.valueTruncated) {
        rejectOnce(payloadTooLarge(`Multipart field ${name} exceeds ${maxFieldBytes} bytes`, {
          maxFieldBytes
        }));
        return;
      }

      appendValue(body, name, value);
    });

    parser.on('file', (fieldName, stream, info) => {
      if (settled) {
        stream.resume();
        return;
      }

      let filePath = path.join(directory, randomUUID());
      let size = 0;
      let limited = false;
      fileStreams.add(stream);

      stream.on('data', chunk => {
        size += chunk.length;
      });
      stream.on('limit', () => {
        limited = true;
        rejectOnce(
          payloadTooLarge(
            `Multipart file ${info.filename || fieldName} exceeds ${maxFileBytes} bytes`,
            { maxFileBytes }
          )
        );
      });

      let write = (async () => {
        try {
          await pipeline(stream, createWriteStream(filePath, { flags: 'wx' }));
          if (limited || settled) return;

          files.push({
            fieldName,
            encoding: info.encoding,
            mimeType: info.mimeType,
            originalName: info.filename,
            path: filePath,
            size
          });
        } catch (error) {
          rejectOnce(error);
        } finally {
          fileStreams.delete(stream);
        }
      })();

      fileWrites.push(write);
    });

    parser.on('fieldsLimit', () => {
      rejectOnce(payloadTooLarge(`Multipart request exceeds ${maxFields} fields`, { maxFields }));
    });
    parser.on('filesLimit', () => {
      rejectOnce(payloadTooLarge(`Multipart request exceeds ${maxFiles} files`, { maxFiles }));
    });
    parser.on('partsLimit', () => {
      rejectOnce(payloadTooLarge(`Multipart request exceeds ${maxParts} parts`, { maxParts }));
    });
    parser.on('error', error => {
      rejectOnce(error);
    });
    parser.on('finish', async () => {
      try {
        let writes = await Promise.allSettled(fileWrites);
        let failedWrite = writes.find(write => write.status === 'rejected');
        if (failedWrite) rejectOnce(failedWrite.reason);
        if (failure) {
          await rejectAfterCleanup();
          return;
        }

        settled = true;
        resolve({ body, files, cleanup });
      } catch (error) {
        rejectOnce(error);
        await rejectAfterCleanup();
      }
    });

    request.pipe(parser);
  });

  return result;
}
