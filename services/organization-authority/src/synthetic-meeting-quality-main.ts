import { runSyntheticMeetingQualityCommandV1 } from "./composition/synthetic-meeting-quality-cli.js";

process.exitCode = await runSyntheticMeetingQualityCommandV1(process.argv.slice(2));
