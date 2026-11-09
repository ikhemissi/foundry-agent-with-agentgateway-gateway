# How the prompt agent is deployed

Foundry refers to a gateway-connected model as `<connection-name>/<model-name>`. When this sample was built, the azd
agents extension (`azure.ai.agents` `1.0.0-beta.18`) validated the model field of a native prompt deployment as a
model deployment name, which does not contain `/`. This sample therefore deploys the prompt agent through the Foundry
API from lifecycle hooks, keeping that model reference. The hosted agent uses native azd code deployment. The
extension's current behaviour has not been checked again here.
