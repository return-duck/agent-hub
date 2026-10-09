package local.agentstack.api;

import jakarta.validation.Valid;
import local.agentstack.api.dto.AgentDtos;
import local.agentstack.api.dto.ConversationDtos;
import local.agentstack.auth.CurrentUser;
import local.agentstack.domain.AppUser;
import local.agentstack.service.AgentService;
import local.agentstack.service.RunService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/agents")
public class AgentController {

    private final AgentService service;
    private final RunService runService;

    public AgentController(AgentService service, RunService runService) {
        this.service = service;
        this.runService = runService;
    }

    @GetMapping
    public List<AgentDtos.Summary> list(@CurrentUser AppUser user) {
        return service.list(user.getId());
    }

    @PostMapping
    public ResponseEntity<AgentDtos.Detail> create(@CurrentUser AppUser user,
                                                    @Valid @RequestBody AgentDtos.SaveRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(service.create(user.getId(), request));
    }

    @GetMapping("/{id}")
    public AgentDtos.Detail get(@CurrentUser AppUser user, @PathVariable String id) {
        return service.get(id, user.getId());
    }

    @PutMapping("/{id}")
    public AgentDtos.Detail update(@CurrentUser AppUser user, @PathVariable String id,
                                   @Valid @RequestBody AgentDtos.SaveRequest request) {
        return service.update(id, user.getId(), request);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@CurrentUser AppUser user, @PathVariable String id) {
        service.delete(id, user.getId());
        return ResponseEntity.noContent().build();
    }

    /** 发布：幂等，已有 slug 时复用它，链接不会每点一次就变。 */
    @PostMapping("/{id}/publish")
    public AgentDtos.PublishResult publish(@CurrentUser AppUser user, @PathVariable String id) {
        return service.publish(id, user.getId());
    }

    @PostMapping("/{id}/unpublish")
    public AgentDtos.PublishResult unpublish(@CurrentUser AppUser user, @PathVariable String id) {
        return service.unpublish(id, user.getId());
    }

    /** 该 agent 的会话列表，包含公开页面访客开的会话（带 fromVisitor 标记）。 */
    @GetMapping("/{id}/conversations")
    public List<ConversationDtos.Summary> conversations(@CurrentUser AppUser user, @PathVariable String id) {
        return runService.listConversations(user.getId(), id);
    }
}
