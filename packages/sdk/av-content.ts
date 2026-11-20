import type { BraviaTransport, RpcResponse } from "./transport.ts";

export type GetContentListParams = {
  source: string;
  stIdx?: number;
  cnt?: number;
  type?: string;
};

export type ContentListItem = {
  uri: string;
  title?: string | null;
  index?: number;
  dispNum?: string;
  originalDispNum?: string;
  tripletStr?: string;
  programNum?: number;
  programMediaType?: string;
  startDateTime?: string;
  durationSec?: number;
  channelName?: string;
  isProtected?: boolean;
  directRemoteNum?: number;
  isAlreadyPlayed?: boolean;
};

export type PlayingContentInfo = {
  uri: string;
  source?: string;
  title?: string | null;
  dispNum?: string;
  originalDispNum?: string;
  tripletStr?: string;
  programNum?: number;
  programTitle?: string;
  startDateTime?: string;
  durationSec?: number;
  playSpeed?: string;
  bivl_serviceId?: string;
  bivl_assetId?: string;
  bivl_provider?: string;
  mediaType?: string;
};

export type SetPlayContentParams = {
  uri: string;
};

export class AvContent {
  private readonly transport: BraviaTransport;

  constructor(transport: BraviaTransport) {
    this.transport = transport;
  }

  // Version 1.0 uses source, not the uri parameter introduced in later versions.
  public getContentList(params: GetContentListParams): Promise<RpcResponse<[ContentListItem[]]>> {
    return this.transport.call<[ContentListItem[]]>("avContent", "getContentList", [params]);
  }

  public getPlayingContentInfo(): Promise<RpcResponse<[PlayingContentInfo]>> {
    return this.transport.call<[PlayingContentInfo]>("avContent", "getPlayingContentInfo");
  }

  public setPlayContent(params: SetPlayContentParams): Promise<RpcResponse<[]>> {
    return this.transport.call<[]>("avContent", "setPlayContent", [params]);
  }
}
