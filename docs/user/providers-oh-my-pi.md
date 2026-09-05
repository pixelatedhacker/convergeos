# Oh My Pi

ConvergeOS runs [Oh My Pi](https://github.com/can1357/oh-my-pi) through its Agent Client
Protocol interface. Oh My Pi, its credentials, its configuration, and its sessions stay on the
environment that runs your project. A remote browser or phone controls that environment and does
not need a local `omp` installation.

## Install and configure Oh My Pi

Install Oh My Pi on the environment that runs ConvergeOS. Follow the
[Oh My Pi installation guide](https://github.com/can1357/oh-my-pi#install), then run `omp` on that
environment to configure a model provider and its credentials.

Confirm that Oh My Pi can list at least one model:

```sh
omp models --json --no-extensions
```

On web or desktop, open **Settings** > **Providers**, select the environment, then enable
**Oh My Pi**. ConvergeOS uses `omp` from the environment's `PATH` by default. Set **Binary path** if
the executable is elsewhere.

Oh My Pi is off by default. ConvergeOS does not install or authenticate Oh My Pi. When ConvergeOS can
identify a package-manager installation, the provider card can offer that package manager's update
command. Provider settings and credentials that work on your desktop do not apply to a separate
remote environment.

## Select a model

Open the model picker and select **Oh My Pi**. The picker groups models by the provider reported by
Oh My Pi and uses the `provider/model` selector that Oh My Pi accepts.

Select **Default** to keep the model selected by the Oh My Pi session. ConvergeOS never sends
`default` as an ACP model ID. A resumed thread keeps its native Oh My Pi session and model.

Refresh provider status after you change Oh My Pi credentials or model configuration. ConvergeOS runs
the model-list command in the project's working directory, so project-level Oh My Pi configuration
can change the available models.

## Permission modes

ConvergeOS starts one `omp acp` process for each active thread and maps permission modes as follows:

| ConvergeOS mode      | Oh My Pi approval mode | Behavior                                                         |
| ----------------- | ---------------------- | ---------------------------------------------------------------- |
| Supervised        | `always-ask`           | Reads run automatically. Writes and commands ask first.          |
| Auto-accept edits | `write`                | Reads and workspace edits run automatically. Commands ask first. |
| Auto              | `always-ask`           | Oh My Pi asks before writes and commands.                        |
| Full access       | `yolo`                 | Oh My Pi can run tools without routine approval prompts.         |

Oh My Pi can still ask a question or show a safety prompt when its configuration requires one.
You can answer these prompts from web, desktop, or mobile. See [Permission modes](./permission-modes.md)
for the limits of each ConvergeOS mode.

## Project tools and remote clients

Oh My Pi receives the thread's project-scoped ConvergeOS MCP server. This gives the agent the same
project tools when you control the thread locally, through a relay, or from mobile. The MCP server
and its authorization stay on the environment host.

ConvergeOS sends images through ACP when the selected model supports them. Other attachment formats
follow the provider's normal attachment behavior.

## Troubleshoot setup

If ConvergeOS cannot find Oh My Pi, run `omp --version` on the environment and check **Binary path**.
If no models appear, run the model-list command above in the project directory. Configure the
required upstream model credentials in Oh My Pi, then refresh provider status.

If an existing thread cannot resume, confirm that the Oh My Pi session still exists on the same
environment. Native sessions do not move between environments with a browser or mobile client.
