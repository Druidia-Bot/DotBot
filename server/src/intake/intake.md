|* Identity *|

## Recent Conversation History
|* Conversation History *|

## Top-of-Mind Memory Topics
|* Memory Models *|

The user's current message is: "|* User Message *|"

Above is your human's recent conversation history and the memory topics you have been recently taling about about. Your job is to determine which memory model this message belongs in, and whether you need to start a new memory model because it introduces a new person, place, business, project, concept, or topic.

Answer each of the following questions. Return your answers as a single JSON object.

1. "multipleTopics": Does this conversation history span multiple topics, projects, places, or people?
2. "continuationScore": Does the user's current input continue the logical conversation of the last topic discussed in this thread? (0-10 scale)
3. "contextConfidence": Do you have enough context to accurately respond to this request without additional information not found in the chat thread? Keep in mind the conversation may span multiple projects — it is your job to determine the context of this latest message. Return a number from 0.0 to 1.0 representing your confidence. 0.98+ means you are virtually certain you understand the full context.
4. "restatedRequest": Restate the user's request in the context of the current conversation. Same disclaimer: this could be a mix of several projects, so resolve any ambiguous references ("it", "that", "the project", etc.) to their concrete meaning based on the conversation history. If you are uncertain about what the user means, say so explicitly.
5. "automatableConfidence": How automatable is this request? Can the next step be performed entirely by a computer with tools (file access, web search, code execution, etc.), or does it require information or clarification from the user? Return a number from 0.0 to 1.0. High (0.8+) means fully automatable — a computer agent can handle it. Low (<0.3) means it needs human input, clarification, or a decision only the user can make. Mid-range means partially automatable but may need user input at some point.
6. "relevantMemories": Which memory models from the list above are directly relevant to this message? NONE is a valid answer. (give array of { "name": "model name", "confidence": 0.0-1.0 })
7. "relatedMemories": Pick up to 3 other memory topics that might relate to this topic even if not directly referenced.
8. "approach": Think about how you would tackle this request. Frame it as "Here's how I think I'll approach this:" followed by concrete steps. (give array of short step descriptions)
9. "singleTurn": Could all of those steps be consolidated and completed in a single turn? (true/false)
10. "estimatedMinutes": Assuming web searches and file lookups each take about 30 seconds, how many minutes would it take to complete all the steps in your plan? Be realistic and give yourself extra time for unexpected issues. (return a number)
11. "webSearch": Would a web search help with this topic? Return an object: { "helpful": true/false, "queries": ["exact search query 1", "exact search query 2"] }. If not helpful, return { "helpful": false, "queries": [] }.
12. "directResponse": Respond to the user right now. If this is something you will be performing, include your approach steps as bullet points so the user can see how you plan to handle this. If this is something you can not answer until the user gives you more informtion; let them know you will do what you can, but be be clear about needing more information.
13. "requestType": What type of request is this? Must be one of: "simple_command", "direct_task", "compound_task", "conversational", "rfi"

Respond with ONLY valid JSON, no markdown fences.
