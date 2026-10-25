import { useEffect, useRef } from 'react';
import { FolderOpenIcon, UploadIcon } from 'lucide-react';

/**
 * A branded file control. The native input stays in the page (visually hidden) so the
 * label opens the browser picker and keyboard focus still lands on a real file input;
 * the browser's own "Choose files / No file chosen" text never shows.
 */
export function FilePicker({ id, buttonLabel, summary, directory = false, accept, disabled = false, onFiles }: {
  id: string; buttonLabel: string; summary: string; directory?: boolean; accept?: string; disabled?: boolean; onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  // React does not type webkitdirectory, so it is set on the element after mount.
  useEffect(() => { if (directory) input.current?.setAttribute('webkitdirectory', ''); }, [directory]);
  const Icon = directory ? FolderOpenIcon : UploadIcon;
  return <div className="customer-file-picker">
    <input ref={input} id={id} className="sr-only" type="file" multiple={directory} {...(accept ? { accept } : {})} disabled={disabled} onChange={event => onFiles(Array.from(event.target.files ?? []))} />
    <label htmlFor={id} className="customer-button customer-button-secondary"><Icon aria-hidden="true" />{buttonLabel}</label>
    <span className="customer-file-picker-summary" aria-live="polite">{summary}</span>
  </div>;
}
