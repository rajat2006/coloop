export const episodeToolInputSchemas = {
  open_episode: {
    type: "object",
    properties: {
      openingBrief: { type: "string" },
      originalRequest: { type: "string" },
    },
    required: ["openingBrief", "originalRequest"],
    additionalProperties: false,
  },
  get_episode: {
    type: "object",
    properties: { episodeId: { type: "string" } },
    required: ["episodeId"],
    additionalProperties: false,
  },
  cancel_episode: {
    type: "object",
    properties: { episodeId: { type: "string" }, reason: { type: "string" } },
    required: ["episodeId"],
    additionalProperties: false,
  },
} as const;

export type EpisodeToolName = keyof typeof episodeToolInputSchemas;

type StringObjectSchema = {
  readonly properties: Readonly<Record<string, { readonly type: "string" }>>;
  readonly required: readonly string[];
};

type PropertyKey<Schema extends StringObjectSchema> =
  keyof Schema["properties"] & string;

type RequiredPropertyKey<Schema extends StringObjectSchema> = Extract<
  Schema["required"][number],
  PropertyKey<Schema>
>;

type InputFor<Schema extends StringObjectSchema> = {
  readonly [Key in RequiredPropertyKey<Schema>]: string;
} & {
  readonly [Key in Exclude<
    PropertyKey<Schema>,
    RequiredPropertyKey<Schema>
  >]?: string;
};

export type EpisodeToolArguments = {
  readonly [Operation in EpisodeToolName]: InputFor<
    (typeof episodeToolInputSchemas)[Operation]
  >;
};

export type CodexRequest = {
  readonly [Operation in EpisodeToolName]: {
    readonly operation: Operation;
    readonly arguments: EpisodeToolArguments[Operation];
  };
}[EpisodeToolName];
