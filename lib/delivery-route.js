// Output addresses are request snapshots, never inferred from conversation history.
export function normalizeDeliveryTarget(value) {
  if (!value || value.mode === 'conversation') return { mode: 'conversation' };
  if (value.mode !== 'onebot' || !String(value.channelId ?? '').trim() || !['private','group'].includes(value.peerKind) || !/^\d{1,20}$/.test(String(value.peerId ?? ''))) {
    throw Object.assign(new Error('请选择明确的 OneBot 连接及私聊或群聊对象'), {code:'INVALID',status:400});
  }
  return {mode:'onebot',channelId:String(value.channelId),peerKind:value.peerKind,peerId:String(value.peerId)};
}
export function requestDelivery(task, opts = {}) {
  if (opts.source === 'message') {
    const m = opts.meta ?? {};
    if(m.channelType==='qq-official')return {mode:'source',channelId:m.channelId,peerId:m.peerId,peerKind:m.kind==='qq_group'?'group':'private'};
    return normalizeDeliveryTarget({mode:'onebot',channelId:m.channelId,peerId:m.peerId,peerKind:m.kind === 'qq_group' ? 'group' : 'private'});
  }
  return normalizeDeliveryTarget(task?.deliveryTarget);
}
