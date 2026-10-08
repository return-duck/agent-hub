package local.agentstack.api;

import jakarta.validation.Valid;
import local.agentstack.api.dto.AgentDtos;
import local.agentstack.service.AgentService;
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

    public AgentController(AgentService service) {
        this.service = service;
    }

    @GetMapping
    public List<AgentDtos.Summary> list() {
        return service.list();
    }

    @PostMapping
    public ResponseEntity<AgentDtos.Detail> create(@Valid @RequestBody AgentDtos.SaveRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(service.create(request));
    }

    @GetMapping("/{id}")
    public AgentDtos.Detail get(@PathVariable String id) {
        return service.get(id);
    }

    @PutMapping("/{id}")
    public AgentDtos.Detail update(@PathVariable String id, @Valid @RequestBody AgentDtos.SaveRequest request) {
        return service.update(id, request);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        service.delete(id);
        return ResponseEntity.noContent().build();
    }
}
