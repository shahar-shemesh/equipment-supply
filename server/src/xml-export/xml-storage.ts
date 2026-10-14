//the contract between the worker and wherever the documents land. two backends implement it, s3-storage.service.ts
//and local-xml-storage.service.ts; the module hands the worker one of them under this token from XML_EXPORT_STORAGE
export const XML_STORAGE = 'XML_STORAGE';

//what goes next to the body: on s3 the object metadata, locally the sidecar file. the head after a taken key
//compares event-id and content-sha256
export type ObjectMetadata = { 'event-id': string; 'issuance-id': string; sequence: string; 'content-sha256': string };

//what the worker needs to know about a failure of either backend. precondition: the key is taken (a 412, an EEXIST),
//the worker compares the metadata through head(). transient: worth another attempt after the backoff; with config
//true the log says the bucket, the policy or the directory is what to look at. permanent: no attempt will help, the
//worker fails the row for a manager (a key that resolves outside the directory, a foreign claim on the key)
export type StorageErrorCategory = 'precondition' | 'transient' | 'permanent';

export class StorageError extends Error {
  constructor(public readonly category: StorageErrorCategory, message: string, public readonly config = false, public readonly cause?: unknown) {
    super(message);
  }
}

export interface XmlStorage {
  //writes the document under the key, never over an existing one: a taken key is a StorageError of category
  //precondition and the worker goes to head()
  putIfAbsent(key: string, body: Buffer, metadata: ObjectMetadata): Promise<void>;

  //the metadata under the key, or null when nothing is there
  head(key: string): Promise<{ metadata: Record<string, string> } | null>;
}
