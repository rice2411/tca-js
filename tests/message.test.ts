import { describe, expect, it } from 'vitest';
import { parseConversation, parseMessage } from '../src/models/message';
import { MessageType, MsgF, REACTION_HEART } from '../src/protocol/constants';
import { Msg, Writer } from '../src/protocol/proto';
import { messageBody, OWN, parse, PEER, reaction } from './helpers';

describe('parseMessage', () => {
  it('parses a text message', () => {
    const msg = parseMessage(parse(messageBody()), OWN);
    expect(msg).toMatchObject({
      conversationId: `0:1:${OWN}:${PEER}`,
      conversationShortId: '7300000000000000999',
      serverMessageId: '7400000000000000123',
      index: '1731400000000000',
      type: MessageType.Text,
      kind: 'text',
      senderId: PEER,
      isSelf: false,
      text: 'hello',
      image: null,
      sticker: null,
      reactions: [],
      content: { aweType: 0, text: 'hello' },
      createdAt: 1731400000000,
      clientMessageId: 'cid-1',
      ext: { 's:client_message_id': 'cid-1', 's:other': 'x' },
    });
  });

  it('flags own messages and keeps non-JSON content as a string', () => {
    const msg = parseMessage(parse(messageBody({ sender: OWN, content: 'not json' })), OWN);
    expect(msg.isSelf).toBe(true);
    expect(msg.content).toBe('not json');
    expect(msg.text).toBe('');
  });

  it('maps message types to kinds', () => {
    const kind = (type: number) => parseMessage(parse(messageBody({ type, content: '{}' })), OWN).kind;
    expect(kind(MessageType.ShareVideo)).toBe('video');
    expect(kind(MessageType.System)).toBe('system');
    expect(kind(MessageType.Command)).toBe('command');
    expect(kind(12345)).toBe('other');
  });

  it('parses a private image attachment', () => {
    const body = messageBody({
      type: MessageType.PrivateImage,
      content: '',
      extend: (w) =>
        w.msg(
          MsgF.attachments,
          new Writer().msg(
            4,
            new Writer()
              .msg(
                1,
                new Writer()
                  .bytes(1, 'tos-uri')
                  .bytes(2, 'https://cdn/origin')
                  .bytes(2, 'https://cdn/origin-backup')
                  .msg(5, new Writer().int(1, 640).int(2, 480))
                  .bytes(6, 'deadbeef'),
              )
              .msg(2, new Writer().bytes(2, 'https://cdn/thumb')),
          ),
        ),
    });
    const msg = parseMessage(parse(body), OWN);
    expect(msg.kind).toBe('image');
    expect(msg.image).toEqual({
      uri: 'tos-uri',
      url: 'https://cdn/origin',
      thumbUrl: 'https://cdn/thumb',
      width: 640,
      height: 480,
      decryptKey: 'deadbeef',
    });
  });

  it('returns image null when the attachment is missing', () => {
    expect(parseMessage(parse(messageBody({ type: MessageType.PrivateImage })), OWN).image).toBeNull();
  });

  it('parses a sticker', () => {
    const body = messageBody({
      type: MessageType.Sticker,
      content: '',
      extend: (w) =>
        w.msg(
          MsgF.attachments,
          new Writer().msg(
            7,
            new Writer()
              .msg(
                1,
                new Writer()
                  .bytes(1, 'sticker-uri')
                  .bytes(2, 'https://sticker/cdn.webp')
                  .msg(5, new Writer().int(1, 200).int(2, 180)),
              )
              .bytes(2, '[Sticker]')
              .msg(200, new Writer().msg(1, new Writer().map(2, { 'a:sticker_id': '42', 'a:sticker_type': '15' }))),
          ),
        ),
    });
    const msg = parseMessage(parse(body), OWN);
    expect(msg.kind).toBe('sticker');
    expect(msg.sticker).toEqual({
      stickerId: '42',
      stickerType: 15,
      url: 'https://sticker/cdn.webp',
      width: 200,
      height: 180,
    });
  });

  it('parses reactions and merges legacy e:love into ❤️', () => {
    const body = messageBody({
      extend: (w) =>
        w
          .msg(MsgF.propertyList, reaction(`e:${REACTION_HEART}`, [OWN]))
          .msg(MsgF.propertyList, reaction('e:love', [OWN, PEER]))
          .msg(MsgF.propertyList, reaction('e:😂', [PEER]))
          .msg(MsgF.propertyList, reaction('e:😮', []))
          .msg(MsgF.propertyList, reaction('s:not_a_reaction', [PEER])),
    });
    const { reactions } = parseMessage(parse(body), OWN);
    expect(reactions).toEqual([
      { emoji: REACTION_HEART, userIds: [OWN, PEER] },
      { emoji: '😂', userIds: [PEER] },
    ]);
  });
});

describe('parseConversation', () => {
  it('reads ids, participants and the peer', () => {
    const conv = new Writer()
      .bytes(1, `0:1:${OWN}:${PEER}`)
      .int(2, '7300000000000000999')
      .int(3, 1)
      .msg(6, new Writer().msg(1, new Writer().int(1, OWN)).msg(1, new Writer().int(1, PEER)));
    expect(parseConversation(Msg.parse(conv.finish()), OWN)).toEqual({
      conversationId: `0:1:${OWN}:${PEER}`,
      conversationShortId: '7300000000000000999',
      participants: [OWN, PEER],
      peerId: PEER,
    });
  });

  it('has an empty peer when only the own account participates', () => {
    const conv = new Writer()
      .bytes(1, 'c')
      .int(2, 1)
      .msg(6, new Writer().msg(1, new Writer().int(1, OWN)));
    expect(parseConversation(Msg.parse(conv.finish()), OWN).peerId).toBe('');
  });
});
