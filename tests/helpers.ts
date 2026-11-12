import { MessageType, MsgF } from '../src/protocol/constants';
import { Msg, Writer } from '../src/protocol/proto';

export const OWN = '7000000000000000001';
export const PEER = '7000000000000000002';

/** A `MessageBody` as TikTok sends it; `extend` adds attachments / properties. */
export function messageBody(
  opts: { type?: number; content?: string; sender?: string; extend?: (w: Writer) => void } = {},
): Writer {
  const w = new Writer()
    .bytes(MsgF.conversationId, `0:1:${OWN}:${PEER}`)
    .int(MsgF.conversationType, 1)
    .int(MsgF.serverMessageId, '7400000000000000123')
    .int(MsgF.indexInConversation, '1731400000000000')
    .int(MsgF.conversationShortId, '7300000000000000999')
    .int(MsgF.type, opts.type ?? MessageType.Text)
    .int(MsgF.sender, opts.sender ?? PEER)
    .bytes(MsgF.content, opts.content ?? JSON.stringify({ aweType: 0, text: 'hello' }))
    .map(MsgF.ext, { 's:client_message_id': 'cid-1', 's:other': 'x' })
    .int(MsgF.createTime, 1731400000000);
  opts.extend?.(w);
  return w;
}

export const parse = (w: Writer): Msg => Msg.parse(w.finish());

/** A reaction property entry `{1 key, 2 {1 [{1 uid}…]}}`. */
export function reaction(key: string, uids: string[]): Writer {
  const items = new Writer();
  for (const uid of uids) items.msg(1, new Writer().int(1, uid).int(3, 1731400000).bytes(4, 'idem'));
  return new Writer().bytes(1, key).msg(2, items);
}
