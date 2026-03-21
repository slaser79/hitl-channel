export interface HitlAttachment {
  type: string;
  media_type: string;
  data: string;
  fileName?: string;
}

export interface HitlMessage {
  message?: string;
  content?: string;
  sender_id?: string;
  agent_id?: string;
  attachments?: HitlAttachment[];
}

export interface ChannelMeta {
  message_id: string;
  ts: string;
  sender_id: string;
  agent_id?: string;
  [key: string]: string | undefined;
}

export interface ReplyPayload {
  type: "reply";
  text: string;
  content: string;
  id: string;
  message_id?: string;
  agent_id?: string;
  ts: string;
}

export interface HitlWebSocket {
  readyState: number;
  send: (data: string) => void;
}
