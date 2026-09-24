import { ChestChannel } from "./channel.js";
export interface RecordRepository { read(): Promise<string>; write(value: string): Promise<void> }

// Experimental client for the existing record capability, not a full SDK.
export class ChestRecord implements RecordRepository {
  constructor(private readonly channel: ChestChannel) {}
  static stdio(): ChestRecord { return new ChestRecord(ChestChannel.stdio()); }
  async read(): Promise<string> { return (await this.channel.exchange("GET", "/record", "", [200])).body; }
  async write(value: string): Promise<void> { await this.channel.exchange("PUT", "/record", value, [204]); }
  close(): void { this.channel.close(); }
}
