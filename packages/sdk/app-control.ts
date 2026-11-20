import type { BraviaTransport, RpcResponse } from "./transport.ts";

export interface Application {
  title: string;
  uri: string;
  icon?: string;
}

export interface SetActiveAppParams {
  uri: string;
}

export interface GetApplicationListResponse extends RpcResponse<[Application[]]> {}

export interface SetActiveAppResponse extends RpcResponse<[]> {}

export class AppControl {
  private readonly transport: BraviaTransport;

  constructor(transport: BraviaTransport) {
    this.transport = transport;
  }

  getApplicationList(): Promise<GetApplicationListResponse> {
    return this.transport.call<[Application[]]>("appControl", "getApplicationList");
  }

  setActiveApp(params: SetActiveAppParams): Promise<SetActiveAppResponse> {
    return this.transport.call<[]>("appControl", "setActiveApp", [params]);
  }
}
