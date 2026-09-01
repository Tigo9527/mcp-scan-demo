import { MCPInput, MCPTool } from "mcp-framework";
import { z } from "zod";

const echoSchema = z.object({
  message: z.string().min(1).describe("The message to echo"),
});

class EchoTool extends MCPTool {
  name = "echo";
  description = "Returns the provided message";
  schema = echoSchema;
  protected useStringify = false;

  async execute(input: MCPInput<this>) {
    return `Echo: ${input.message}`;
  }
}

export default EchoTool;
