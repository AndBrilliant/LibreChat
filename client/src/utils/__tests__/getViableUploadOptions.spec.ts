import { getViableUploadOptions } from '../files';

const file = (type: string, name: string) => new File(['x'], name, { type });

describe('getViableUploadOptions', () => {
  it('returns empty for no files', () => {
    expect(getViableUploadOptions([])).toEqual([]);
  });

  it('returns empty when a file type cannot be inferred', () => {
    expect(getViableUploadOptions([file('', 'mystery.unknownext')])).toEqual([]);
  });

  it('resolves any recognized file type to the single sandbox destination', () => {
    expect(getViableUploadOptions([file('application/pdf', 'doc.pdf')])).toEqual([undefined]);
    expect(getViableUploadOptions([file('application/zip', 'a.zip')])).toEqual([undefined]);
    expect(getViableUploadOptions([file('video/mp4', 'clip.mp4')])).toEqual([undefined]);
  });

  it('still requires every file in a multi-file set to have a recognizable type', () => {
    expect(
      getViableUploadOptions([file('application/pdf', 'doc.pdf'), file('', 'mystery.unknownext')]),
    ).toEqual([]);
  });
});
