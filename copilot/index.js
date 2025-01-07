const { Client } = require('@vonage/server-sdk');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const jwt = require('jsonwebtoken');
const fs = require('fs');
const express = require('express');
const app = express();
app.use(express.json());
const crypto = require('crypto');
require('dotenv').config();

// Vonage and Flowise configuration
const VONAGE_MESSAGES_API_URL = "https://api.nexmo.com/v1/messages";
const VONAGE_APPLICATION_ID = "40644e33-8740-4cb0-bb17-410f414c5e1a";
const FLOWISE_API_URL = "http://4.156.31.14:3000/api/v1/prediction/97c042a7-6007-4885-9eb4-806f8ab8a267";
const VONAGE_SANDBOX_NUMBER = "254769123018";  // Replace with your Vonage number
const FEEDBACK_FORM_URL = "https://forms.office.com/r/N9j8TFyN0g";

// Path to private key file
const PRIVATE_KEY_FILE_PATH = './copilot/private.pem';

// Load the Private Key from file
const VONAGE_PRIVATE_KEY = fs.readFileSync(PRIVATE_KEY_FILE_PATH, 'utf8');

// Initialize user-related data structures
const processedMessageUuids = new Set();
const userLastInteraction = {};
const userConversationHistory = {};
const userMessageCount = {};
const userConversationStartTime = {};
const userPreferences = {};
const userFeedback = {};

// Constants
const REMINDER_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const END_PROMPT_KEYWORDS = ["thank you", "thanks", "bye", "goodbye", "that's all", "no more questions", "end"];
const RATING_PROMPT_KEYWORDS = ["rate", "rating", "score"];
const MESSAGE_THRESHOLD = 10;
const CONVERSATION_TIMEOUT = 5 * 60 * 1000; // 5 minutes in milliseconds


module.exports = async function (context, req) {
    context.log('Request received');
    const request_body = req.body;
    context.log('Request body:', request_body);

    if (req.method === 'POST') {
        const response = await handleVonageInbound(context, request_body);
        context.res = {
            status: 200,
            body: response
        };
    } else {
        context.res = {
            status: 405, // Method Not Allowed
            body: 'Method not supported'
        };
    }
};

// Handle incoming messages from Vonage
async function handleVonageInbound(context, data) {
    context.log('Incoming data:', data);

    try {
        const message_uuid = data.message_uuid;
        const sender_phone_number = data.from;

        if (processedMessageUuids.has(message_uuid)) {
            context.log('Duplicate message received, skipping processing.');
            return { status: 200 };
        }

        processedMessageUuids.add(message_uuid);
        userLastInteraction[sender_phone_number] = Date.now();

        // Initialize or update user message count and conversation start time
        if (!userMessageCount[sender_phone_number]) {
            userMessageCount[sender_phone_number] = 0;
            userConversationStartTime[sender_phone_number] = Date.now();
            await sendWelcomeMessage(sender_phone_number);
        }
        userMessageCount[sender_phone_number]++;

        const message_type = data.message_type;
        if (!message_type) {
            context.log('Received message with no type, possibly from Flowise.');
            return { message: 'No action needed for no-type message', status: 200 };
        }

        if (message_type === 'text') {
            const incoming_msg = data.text || '';

            // Handle special commands
            if (incoming_msg.toLowerCase() === 'help') {
                return await handleHelpCommand(sender_phone_number);
            } else if (incoming_msg.toLowerCase().startsWith('feedback:')) {
                return await handleFeedbackCommand(sender_phone_number, incoming_msg);
            } else if (incoming_msg.toLowerCase() === 'summary') {
                return await handleSummaryCommand(sender_phone_number);
            } else if (incoming_msg.toLowerCase() === 'preferences') {
                return await handlePreferencesCommand(sender_phone_number);
            } else if (incoming_msg.toLowerCase() === 'tip') {
                return await handleTipCommand(sender_phone_number);
            }

            const userInputLowerCase = incoming_msg.toLowerCase();
            const isEndOfConversion = END_PROMPT_KEYWORDS.some(keyword => userInputLowerCase.includes(keyword));
            
            if (isEndOfConversion) {
                return await handleEndOfConversation(sender_phone_number);
            }

            // Regular message processing
            const flowise_response = await queryFlowise(context, incoming_msg, sender_phone_number, userConversationHistory[sender_phone_number] || []);
            userConversationHistory[sender_phone_number] = updateConversationHistory(userConversationHistory[sender_phone_number], incoming_msg, flowise_response);

            let response_message;
            if (typeof flowise_response === 'object' && 'value' in flowise_response) {
                response_message = flowise_response.value;
            } else {
                response_message = flowise_response;
            }

            if (response_message) {
                await sendWhatsappMessage(sender_phone_number, response_message);
                
                // // Check if it's time to send the feedback form
                // if (shouldSendFeedbackForm(sender_phone_number)) {
                //     await sendFeedbackForm(sender_phone_number);
                // }
                
                return {
                    status: 'success',
                    response_from_flowise: response_message
                };
            } else {
                return { message: 'Failed to process text message.', status: 500 };
            }
        } else {
            context.error(`Unhandled message type: ${message_type}`);
            return { message: 'Message type not supported.', status: 400 };
        }
    } catch (e) {
        context.log.error(`Exception in handleVonageInbound: ${e}`);
        const error_message = 'I apologize, but I encountered an unexpected issue. Please try again in a moment, and if the problem persists, don t hesitate to contact our support teamh ere: +254708419386';
        return { message: error_message, status: 500 };
    }
}

// Send a message via WhatsApp using Vonage API
async function sendWhatsappMessage(to_number, text_message) {
    const token = generateJwt(VONAGE_APPLICATION_ID, VONAGE_PRIVATE_KEY);
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    };

    const payload = {
        from: VONAGE_SANDBOX_NUMBER,
        to: to_number,
        message_type: "text",
        text: text_message,
        channel: "whatsapp"
    };

    console.log(`Sending payload to Vonage API: ${JSON.stringify(payload)}`);

    try {
        const response = await fetch(VONAGE_MESSAGES_API_URL, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
        });

        if (response.status === 202) {
            const data = await response.json();
            const message_uuid = data.message_uuid;
            console.log(`Message accepted by Vonage, UUID: ${message_uuid}`);
        } else {
            console.error(`Failed to send message via Vonage, Status Code: ${response.status}, Response Body: ${response.statusText}`);
        }
    } catch (error) {
        console.error(`Error sending message via Vonage: ${error}`);
    }
}

// Query Flowise for a response
async function queryFlowise(context, question, chatId, history = null, overrideConfig = null) {
    const payload = {
        question: question,
        chatId: chatId
    };

    if (history !== null) {
        payload.history = history;
    }
    if (overrideConfig !== null) {
        payload.overrideConfig = overrideConfig;
    }

    const headers = { "Content-Type": "application/json" };

    context.log(`Payload for Flowise: ${JSON.stringify(payload)}`);

    try {
        const response = await fetch(FLOWISE_API_URL, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const response_data = await response.json();
        context.log(`Response from Flowise: ${JSON.stringify(response_data)}`);

        const messages = response_data.assistant?.messages || [];
        if (messages.length > 0) {
            const answer_section = messages[0].content?.[0]?.text || 'I apologize, but I couldn\'t process your request at the moment. Could you please try rephrasing your question☺️?';
            return answer_section;
        } else {
            return 'I apologize, but I couldn\'t process your request at the moment. Could you please try rephrasing your question?';
        }
    } catch (e) {
        context.log(`Error querying Flowise: ${e}`);
        return "I apologize, but our systems are currently experiencing high demand. Please try again in a few moments. If the issue persists, feel free to contact our support team here: +254708419386";
    }
}

// Generate JWT for Vonage API
function generateJwt(application_id, private_key) {
    const current_time = Math.floor(Date.now() / 1000);
    const payload = {
        iat: current_time,
        jti: `${current_time}-${crypto.randomBytes(64).toString('hex')}`,
        application_id: application_id
    };
    return jwt.sign(payload, private_key, { algorithm: 'RS256' });
}

// Update conversation history
function updateConversationHistory(history, userMessage, botResponse) {
    if (!history) {
        history = [];
    }
    history.push({ role: 'user', content: userMessage });
    history.push({ role: 'bot', content: botResponse });
    return history;
}

// // New function to send welcome message
async function sendWelcomeMessage(sender_phone_number) {
    const welcomeMessage = "Welcome!";
    await sendWhatsappMessage(sender_phone_number, welcomeMessage);
}

// New function to handle help command
async function handleHelpCommand(sender_phone_number) {
    const helpMessage = "Here are some ways I can support your mental health journey: 🌟\n" +
    "1. Ask me any question about mental health, wellness, or self-care. 🧠💆‍♀️\n" +
    "2. Say 'feedback: your message' to share your thoughts on our interaction. 📝\n" +
    "3. Say 'summary' to get a recap of our conversation. 📚\n" +
    "4. Say 'preferences' to personalize your chat experience. ⚙️\n" +
    "5. Say 'tip' to get a random mental health tip. 💡\n" +
    "6. Share images or videos related to your mental health journey. 🖼️\n" +
    "Remember, I'm here to support you, so don't hesitate to reach out! 🤗";
    await sendWhatsappMessage(sender_phone_number, helpMessage);
    return {
        status: 'success',
        response_from_flowise: helpMessage
    };
}

// New function to handle feedback command
async function handleFeedbackCommand(sender_phone_number, incoming_msg) {
    const feedbackMessage = incoming_msg.substring(9).trim();
    handleUserFeedback(sender_phone_number, feedbackMessage);
    const thanksMessage = "Thank you for your valuable feedback! We greatly appreciate your input as it helps us improve our service.";
    await sendWhatsappMessage(sender_phone_number, thanksMessage);
    return {
        status: 'success',
        response_from_flowise: thanksMessage
    };
}

// New function to handle summary command
async function handleSummaryCommand(sender_phone_number) {
    const history = userConversationHistory[sender_phone_number] || [];
    const summary = generateConversationSummary(history);
    await sendWhatsappMessage(sender_phone_number, summary);
    return {
        status: 'success',
        response_from_flowise: summary
    };
}

// New function to handle preferences command
async function handlePreferencesCommand(sender_phone_number) {
    const currentPreferences = userPreferences[sender_phone_number] || {};
    const preferencesMessage = "Here are your current preferences:\n" +
        `Language: ${currentPreferences.language || 'Not set'}\n` +
        `Notification frequency: ${currentPreferences.notificationFrequency || 'Not set'}\n\n` +
        "To update your preferences, please reply with:\n" +
        "preferences: language=<your language>, notifications=<daily/weekly/monthly>";
    await sendWhatsappMessage(sender_phone_number, preferencesMessage);
    return {
        status: 'success',
        response_from_flowise: preferencesMessage
    };
}

// New function to handle tip command
async function handleTipCommand(sender_phone_number) {
    const randomTip = QUICK_TIPS[Math.floor(Math.random() * QUICK_TIPS.length)];
    await sendWhatsappMessage(sender_phone_number, `Quick Tip: ${randomTip}`);
    return {
        status: 'success',
        response_from_flowise: `Quick Tip: ${randomTip}`
    };
}

// New function to handle end of conversation
async function handleEndOfConversation(sender_phone_number) {
    const farewellMessage = "would you mind taking a quick survey to help us improve? Just reply with 'yes' if you're interested.";
    await sendWhatsappMessage(sender_phone_number, farewellMessage);
    return {
        status: 'success',
        response_from_flowise: farewellMessage
    };
}

// Function to determine if feedback form should be sent
function shouldSendFeedbackForm(sender_phone_number) {
    const messageCount = userMessageCount[sender_phone_number] || 0;
    const conversationStartTime = userConversationStartTime[sender_phone_number] || 0;
    const currentTime = Date.now();

    return messageCount >= MESSAGE_THRESHOLD || (currentTime - conversationStartTime) >= CONVERSATION_TIMEOUT;
}

// Function to send feedback form
// async function sendFeedbackForm(sender_phone_number) {
//     const feedbackMessage = `We value your opinion! Please take a moment to fill out our feedback form: ${FEEDBACK_FORM_URL}`;
//     await sendWhatsappMessage(sender_phone_number, feedbackMessage);
    
//     // Reset the message count and conversation start time
//     userMessageCount[sender_phone_number] = 0;
//     userConversationStartTime[sender_phone_number] = Date.now();
// }

// New function to generate conversation summary
function generateConversationSummary(history) {
    if (history.length === 0) {
        return "We haven't had any conversation yet. Feel free to ask me anything!";
    }

    let summary = "Here's a summary of our conversation:\n\n";
    const maxSummaryLength = 5; // Adjust this to change the number of exchanges in the summary

    for (let i = Math.max(0, history.length - maxSummaryLength * 2); i < history.length; i += 2) {
        const userMessage = history[i].content;
        const botResponse = history[i + 1]?.content || "No response";
        summary += `You: ${userMessage}\nMe: ${botResponse}\n\n`;
    }

    return summary.trim();
}

// Function to handle user feedback
function handleUserFeedback(user, feedback) {
    console.log(`Feedback from ${user}: ${feedback}`);
    // Store the feedback
    if (!userFeedback[user]) {
        userFeedback[user] = [];
    }
    userFeedback[user].push({
        timestamp: new Date(),
        feedback: feedback
    });
    // Implement any additional feedback handling logic here (e.g., storing feedback in a database)
}

// Check for inactive users and send reminders
async function checkForInactiveUsers() {
    const currentTime = Date.now();
    for (const user in userLastInteraction) {
        const lastInteractionTime = userLastInteraction[user];
        const timeSinceLastInteraction = currentTime - lastInteractionTime;
        
        // If the user hasn't interacted in the last 24 hours and hasn't been reminded recently
        if (timeSinceLastInteraction >= REMINDER_INTERVAL) {
            await sendWhatsappMessage(user, "Hello! It's been a while since we last chatted. Is there anything I can help you with today? Remember, I'm here to assist you with any questions or information you need.");
            // Update the last interaction time to the current time
            userLastInteraction[user] = currentTime;
        }
    }
}

// Set interval to check for inactive users every hour
setInterval(checkForInactiveUsers, 60 * 60 * 1000);

// Start the server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something went wrong! Please try again later.');
});

// 404 handler
app.use((req, res, next) => {
    res.status(404).send("Sorry, we couldn't find what you were looking for.");
});