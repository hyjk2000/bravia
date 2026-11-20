import type { BraviaTransport, RpcResponse } from "./transport.ts";

export interface InterfaceInformation {
  productCategory: string;
  productName: string;
  modelName: string;
  serverName: string;
  interfaceVersion: string;
}

export interface SystemInformation {
  product: string;
  language?: string;
  model: string;
  serial?: string;
  macAddr?: string;
  name: string;
  generation?: string;
}

export interface PowerStatus {
  status: "active" | "standby";
}

export interface SetPowerStatusParams {
  status: boolean;
}

export interface GetInterfaceInformationResponse extends RpcResponse<[InterfaceInformation]> {}

export interface GetSystemInformationResponse extends RpcResponse<[SystemInformation]> {}

export interface GetPowerStatusResponse extends RpcResponse<[PowerStatus]> {}

export interface SetPowerStatusResponse extends RpcResponse<[]> {}

export class System {
  private readonly transport: BraviaTransport;

  constructor(transport: BraviaTransport) {
    this.transport = transport;
  }

  getInterfaceInformation(): Promise<GetInterfaceInformationResponse> {
    return this.transport.call<[InterfaceInformation]>("system", "getInterfaceInformation");
  }

  getSystemInformation(): Promise<GetSystemInformationResponse> {
    return this.transport.call<[SystemInformation]>("system", "getSystemInformation");
  }

  getPowerStatus(): Promise<GetPowerStatusResponse> {
    return this.transport.call<[PowerStatus]>("system", "getPowerStatus");
  }

  setPowerStatus(params: SetPowerStatusParams): Promise<SetPowerStatusResponse> {
    return this.transport.call<[]>("system", "setPowerStatus", [params]);
  }
}
