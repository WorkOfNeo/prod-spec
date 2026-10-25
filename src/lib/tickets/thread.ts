// A rejection ticket keeps its whole conversation in one `comment` string: a
// re-rejection appends "— re-rejected <stamp> —" and the new text (see
// createOrReopenRejectionTicket). This splits it back into the comments the
// reviewer typed, oldest first, so the review screen can show them as a thread.

export type ThreadEntry = {
  // The stamp the server wrote for an appended comment ("12 Oct 2026, 14:03");
  // null for the first comment, whose time is the ticket's createdAt.
  stamp: string | null;
  text: string;
};

const SEPARATOR = /\n\n— re-rejected (.+?) —\n/;

export function splitTicketComment(comment: string): ThreadEntry[] {
  const parts = comment.split(SEPARATOR);
  // split() with one capture group alternates text, stamp, text, stamp, …
  const entries: ThreadEntry[] = [{ stamp: null, text: parts[0].trim() }];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    entries.push({ stamp: parts[i], text: parts[i + 1].trim() });
  }
  return entries.filter((e) => e.text.length > 0);
}
