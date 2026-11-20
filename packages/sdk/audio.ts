import type { BraviaTransport, RpcResponse } from "./transport.ts";

export interface VolumeInformation {
  target: string;
  volume: number;
  mute: boolean;
  minVolume: number;
  maxVolume: number;
}

export interface SetAudioMuteParams {
  status: boolean;
}

export interface SetAudioVolumeParams {
  target: string;
  /** Absolute level ("25") or relative adjustment ("+1" or "-1"). */
  volume: string;
}

export interface GetVolumeInformationResponse extends RpcResponse<[VolumeInformation[]]> {}

export interface SetAudioMuteResponse extends RpcResponse<[0]> {}

export interface SetAudioVolumeResponse extends RpcResponse<[0]> {}

export class Audio {
  private readonly transport: BraviaTransport;

  constructor(transport: BraviaTransport) {
    this.transport = transport;
  }

  getVolumeInformation(): Promise<GetVolumeInformationResponse> {
    return this.transport.call<[VolumeInformation[]]>("audio", "getVolumeInformation");
  }

  setAudioMute(params: SetAudioMuteParams): Promise<SetAudioMuteResponse> {
    return this.transport.call<[0]>("audio", "setAudioMute", [params]);
  }

  setAudioVolume(params: SetAudioVolumeParams): Promise<SetAudioVolumeResponse> {
    return this.transport.call<[0]>("audio", "setAudioVolume", [params]);
  }
}
