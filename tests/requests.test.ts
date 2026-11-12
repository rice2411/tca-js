import { describe, expect, it } from 'vitest';
import { avatarLinks } from '../src/api/account';
import {
  getMessagesBody,
  imageMessageExtra,
  markReadBody,
  NEWEST,
  reactionOps,
  sendMessageBody,
  setPropertyBody,
} from '../src/api/requests';
import { parseMessage } from '../src/models/message';
import { MessageType, PropertyOp, REACTION_HEART } from '../src/protocol/constants';
import { Msg } from '../src/protocol/proto';
import { messageBody, OWN, parse, PEER } from './helpers';

const conv = { conversationId: 'conv-id', conversationShortId: '7300000000000000999' };

describe('request bodies', () => {
  it('getMessagesBody defaults to the newest cursor', () => {
    const m = Msg.parse(getMessagesBody(conv, 20));
    expect(m.str(1)).toBe('conv-id');
    expect(m.id(3)).toBe(conv.conversationShortId);
    expect(m.int(5)).toBe(NEWEST);
    expect(m.num(6)).toBe(20);
    expect(Msg.parse(getMessagesBody(conv, 5, '123')).id(5)).toBe('123');
  });

  it('markReadBody carries the message index', () => {
    const m = Msg.parse(markReadBody({ ...conv, index: '1731400000000000' }));
    expect(m.id(2)).toBe(conv.conversationShortId);
    expect(m.id(4)).toBe('1731400000000000');
  });

  it('sendMessageBody carries content, type and client id', () => {
    const m = Msg.parse(sendMessageBody(conv, 'cid', MessageType.Text, '{"text":"hi"}', null));
    expect(m.str(1)).toBe('conv-id');
    expect(m.str(4)).toBe('{"text":"hi"}');
    expect(m.map(5)).toEqual({ 's:mentioned_users': '', 's:client_message_id': 'cid' });
    expect(m.num(6)).toBe(MessageType.Text);
    expect(m.str(8)).toBe('cid');
  });

  it('sendMessageBody appends image extras', () => {
    const up = { uri: 'u', secretKey: 'k', width: 10, height: 20, size: 99, filename: 'a.png' };
    const m = Msg.parse(sendMessageBody(conv, 'cid', MessageType.PrivateImage, '', imageMessageExtra(up)));
    expect(m.str(14)).toBe('private_image');
    const origin = m.msg(13)?.msg(4)?.msg(1);
    expect(origin?.str(1)).toBe('u');
    expect(origin?.str(6)).toBe('k');
    expect(m.msg(17)?.msg(10)?.str(5)).toBe('a.png');
    expect(m.msg(17)?.msg(10)?.num(4)).toBe(99);
  });
});

describe('reactionOps', () => {
  const msg = (reactions: { emoji: string; userIds: string[] }[]) => ({ reactions });

  it('adds a new reaction', () => {
    expect(reactionOps(msg([]), OWN, '😂')).toEqual([{ op: PropertyOp.Add, key: 'e:😂' }]);
  });

  it('replaces the previous reaction', () => {
    expect(reactionOps(msg([{ emoji: '😮', userIds: [OWN] }]), OWN, '😂')).toEqual([
      { op: PropertyOp.Add, key: 'e:😂' },
      { op: PropertyOp.Remove, key: 'e:😮' },
    ]);
  });

  it('is a no-op when the reaction is already set', () => {
    expect(reactionOps(msg([{ emoji: '😂', userIds: [OWN, PEER] }]), OWN, '😂')).toEqual([]);
  });

  it('removes ❤️ together with the legacy e:love key', () => {
    expect(reactionOps(msg([{ emoji: REACTION_HEART, userIds: [OWN] }]), OWN, null)).toEqual([
      { op: PropertyOp.Remove, key: `e:${REACTION_HEART}` },
      { op: PropertyOp.Remove, key: 'e:love' },
    ]);
  });

  it('ignores other users’ reactions', () => {
    expect(reactionOps(msg([{ emoji: '😮', userIds: [PEER] }]), OWN, null)).toEqual([]);
  });

  it('setPropertyBody targets the message', () => {
    const m = parseMessage(parse(messageBody()), OWN);
    const body = Msg.parse(setPropertyBody(m, [{ op: PropertyOp.Add, key: 'e:😂' }], OWN));
    const target = body.msg(1)!;
    expect(target.id(4)).toBe(m.serverMessageId);
    expect(target.str(5)).toBe('cid-1');
    expect(target.msgs(6).map((o) => [o.num(1), o.str(2), o.str(4)])).toEqual([[0, 'e:😂', OWN]]);
  });
});

describe('avatarLinks', () => {
  it('collects unique URLs and ranks heic last', () => {
    const res = avatarLinks({
      thumb: { url_list: ['https://a/1.heic?x=1', 'https://a/1.jpeg'] },
      medium: ['https://a/1.jpeg', 'https://a/2.webp', 'not-a-url'],
    });
    expect(res.avatars).toEqual(['https://a/1.jpeg', 'https://a/2.webp', 'https://a/1.heic?x=1']);
    expect(res.avatar).toBe('https://a/1.jpeg');
    expect(avatarLinks(undefined)).toEqual({ avatar: '', avatars: [] });
  });
});
