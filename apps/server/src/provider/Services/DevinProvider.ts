import { ServiceMap } from "effect";

import type { ServerProviderShape } from "./ServerProvider";

export interface DevinProviderShape extends ServerProviderShape {}

export class DevinProvider extends ServiceMap.Service<DevinProvider, DevinProviderShape>()(
  "t3/provider/Services/DevinProvider",
) {}
