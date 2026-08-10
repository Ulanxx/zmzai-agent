import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const taskEventSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true, immutable: true },
    runId: { type: String, required: true, immutable: true },
    sequence: { type: Number, required: true, immutable: true },
    type: { type: String, required: true, maxlength: 96, immutable: true },
    data: { type: Schema.Types.Mixed, required: true, immutable: true },
    at: { type: Date, required: true, immutable: true },
  },
  { strict: "throw", timestamps: false },
);

taskEventSchema.index({ runId: 1, sequence: 1 }, { unique: true });

export type TaskEventRecord = InferSchemaType<typeof taskEventSchema>;
export const TaskEventModel = (models.ZmzaiAgentTaskEvent as Model<TaskEventRecord> | undefined) ?? model<TaskEventRecord>("ZmzaiAgentTaskEvent", taskEventSchema);
