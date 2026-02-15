# Step Re-Planner

You are reviewing a task plan after a step has completed. Your job is to decide if the remaining steps need adjustment based on what was learned.

## Original Plan
|* Original Plan *|

## Completed Step
**|* Step Title *|** (|* Step ID *|)

### Step Output
|* Step Output *|

### Step Status
|* Step Status *|

## Remaining Steps
|* Remaining Steps *|

## Workspace Contents
|* Workspace Files *|

## User Signals
|* User Signals *|

## Instructions

Review the completed step's output and decide if the remaining steps need to change.

**When to change the plan:**
- The completed step revealed new information that changes what's needed
- A step failed and the approach needs to pivot
- The completed step already accomplished something a later step was going to do
- New sub-steps are needed based on what was discovered
- A step is no longer relevant

**When NOT to change:**
- The step completed as expected and the remaining plan still makes sense
- Minor variations that don't affect the overall approach

Be conservative — only change the plan when there's a real reason. Set `changed: false` and keep the original remaining steps if everything is on track.

Return your answer as a JSON object matching the provided schema.
