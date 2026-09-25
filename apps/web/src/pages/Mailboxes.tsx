import { MailboxPanel } from '../components/MailboxPanel.js';
import { useKb } from './KbLayout.js';
import { PageHeader } from '../components/ui.js';

export function Mailboxes(): React.ReactElement {
  const { kb, library, reloadConnectors } = useKb();

  return (
    <main className="min-h-0 flex-1 overflow-y-auto scroll-slim bg-paper">
      <div className="mx-auto max-w-[1000px] px-8 py-7">
        <PageHeader
          title="Connected mailboxes"
          lede="A mailbox keeps feeding this corpus on a timer. Every message is indexed with its sender and date, and every attachment becomes a document in its own right — through the same OCR, transcription and image pipeline as an upload."
        />

        <MailboxPanel
          kbId={kb.id}
          onImported={() => void library.refresh()}
          onConnectors={() => void reloadConnectors()}
        />
      </div>
    </main>
  );
}
